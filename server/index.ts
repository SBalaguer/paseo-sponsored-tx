import express from "express";
import cors from "cors";
import path from "path";
import rateLimit from "express-rate-limit";
import { ethers } from "ethers";
import * as dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, "..", "frontend")));

// --- Logging helper ---
function log(tag: string, ...args: any[]) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${tag}]`, ...args);
}

// --- Config ---
const PORT = process.env.PORT || 3000;
const RPC_URL = "https://eth-rpc-testnet.polkadot.io/";
const CHAIN_ID = 420420417;
const FORWARDER_ADDRESS = process.env.FORWARDER_ADDRESS!;
const SUBSTRATE_FORWARDER_ADDRESS = process.env.SUBSTRATE_FORWARDER_ADDRESS!;
const TICKET_NFT_ADDRESS = process.env.TICKET_NFT_ADDRESS!;
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY!;

if (!FORWARDER_ADDRESS || !SUBSTRATE_FORWARDER_ADDRESS || !TICKET_NFT_ADDRESS || !DEPLOYER_PRIVATE_KEY) {
  console.error("Missing required env vars: FORWARDER_ADDRESS, SUBSTRATE_FORWARDER_ADDRESS, TICKET_NFT_ADDRESS, DEPLOYER_PRIVATE_KEY");
  process.exit(1);
}

// --- Provider & Signer ---
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const relayer = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);

// --- Contract ABIs (minimal) ---
const FORWARDER_ABI = [
  "function nonces(address owner) view returns (uint256)",
  "function verify((address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature) request) view returns (bool)",
  "function execute((address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature) request) payable",
];

const TICKET_ABI = [
  "function hasMinted(address) view returns (bool)",
  "function totalMinted() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function mintDeadline() view returns (uint256)",
];

const SUBSTRATE_FORWARDER_ABI = [
  "function substrateNonces(bytes32 pubkey) view returns (uint256)",
  "function verify((bytes32 from, address to, uint256 gas, uint48 deadline, bytes data, uint8[64] signature) request) view returns (bool)",
  "function execute((bytes32 from, address to, uint256 gas, uint48 deadline, bytes data, uint8[64] signature) request)",
  "function toH160(bytes32 accountId) pure returns (address)",
];

const forwarder = new ethers.Contract(FORWARDER_ADDRESS, FORWARDER_ABI, relayer);
const substrateForwarder = new ethers.Contract(SUBSTRATE_FORWARDER_ADDRESS, SUBSTRATE_FORWARDER_ABI, relayer);
const ticketNFT = new ethers.Contract(TICKET_NFT_ADDRESS, TICKET_ABI, provider);

// --- Utility: pubkeyToH160 ---
function pubkeyToH160(pubkeyHex: string): string {
  const clean = pubkeyHex.startsWith("0x") ? pubkeyHex.slice(2) : pubkeyHex;
  const suffix = clean.slice(40).toLowerCase();
  if (suffix === "eeeeeeeeeeeeeeeeeeeeeeee") {
    return "0x" + clean.slice(0, 40);
  }
  const hash = ethers.keccak256("0x" + clean);
  return "0x" + hash.slice(26);
}

// --- Anti-spam: wallet dedup (in-memory, resets on restart) ---
const relayedWallets = new Set<string>();
let totalRelayed = 0;

// --- Rate limiting: 3 requests per IP per day ---
const relayLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 3,
  message: { error: "Rate limit exceeded. Max 3 relay requests per day." },
  standardHeaders: true,
  legacyHeaders: false,
});

// --- Request logging middleware ---
app.use((req, _res, next) => {
  log("REQ", req.method, req.path, req.method === "POST" ? JSON.stringify(req.body).slice(0, 200) : "");
  next();
});

// --- Routes ---

app.get("/health", async (_req, res) => {
  log("HEALTH", "Health check requested");
  try {
    const balance = await provider.getBalance(relayer.address);
    log("HEALTH", "Relayer balance:", ethers.formatEther(balance), "PAS");
    res.json({
      status: "ok",
      relayer: relayer.address,
      balance: ethers.formatEther(balance),
      forwarder: FORWARDER_ADDRESS,
      ticketNFT: TICKET_NFT_ADDRESS,
      chainId: CHAIN_ID,
    });
  } catch (e: any) {
    log("HEALTH", "ERROR:", e.message);
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.get("/stats", async (_req, res) => {
  log("STATS", "Stats requested");
  try {
    const balance = await provider.getBalance(relayer.address);
    const totalMinted = await ticketNFT.totalMinted();
    const maxSupply = await ticketNFT.maxSupply();
    log("STATS", `Relayed: ${totalRelayed}, Minted: ${totalMinted}/${maxSupply}, Balance: ${ethers.formatEther(balance)} PAS`);
    res.json({
      totalRelayed,
      relayerBalance: ethers.formatEther(balance),
      totalMinted: totalMinted.toString(),
      maxSupply: maxSupply.toString(),
    });
  } catch (e: any) {
    log("STATS", "ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/nonce/:address", async (req, res) => {
  const { address } = req.params;
  log("NONCE", "Nonce requested for", address);
  try {
    if (!ethers.isAddress(address)) {
      log("NONCE", "REJECTED: invalid address", address);
      res.status(400).json({ error: "Invalid address" });
      return;
    }
    const nonce = await forwarder.nonces(address);
    log("NONCE", address, "->", nonce.toString());
    res.json({ nonce: nonce.toString() });
  } catch (e: any) {
    log("NONCE", "ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/relay", relayLimiter, async (req, res) => {
  const requestId = Math.random().toString(36).slice(2, 8);
  log("RELAY", `[${requestId}] New relay request received`);

  try {
    const { request } = req.body;
    if (!request) {
      log("RELAY", `[${requestId}] REJECTED: missing request body`);
      res.status(400).json({ error: "Missing request in body" });
      return;
    }

    const { from, to, value, gas, deadline, data, signature } = request;
    log("RELAY", `[${requestId}] From: ${from}`);
    log("RELAY", `[${requestId}] To: ${to}`);
    log("RELAY", `[${requestId}] Deadline: ${deadline} (${new Date(Number(deadline) * 1000).toISOString()})`);

    // Security: only allow calls to our TicketNFT
    if (to.toLowerCase() !== TICKET_NFT_ADDRESS.toLowerCase()) {
      log("RELAY", `[${requestId}] REJECTED: target ${to} not whitelisted`);
      res.status(403).json({ error: "Target contract not whitelisted" });
      return;
    }
    log("RELAY", `[${requestId}] Target contract whitelisted OK`);

    // Anti-spam: wallet dedup
    const walletKey = from.toLowerCase();
    if (relayedWallets.has(walletKey)) {
      log("RELAY", `[${requestId}] REJECTED: wallet ${from} already relayed`);
      res.status(429).json({ error: "Already relayed for this wallet" });
      return;
    }
    log("RELAY", `[${requestId}] Wallet dedup check passed`);

    // Check on-chain hasMinted
    log("RELAY", `[${requestId}] Checking on-chain hasMinted...`);
    const alreadyMinted = await ticketNFT.hasMinted(from);
    if (alreadyMinted) {
      log("RELAY", `[${requestId}] REJECTED: address ${from} already minted on-chain`);
      res.status(409).json({ error: "Address has already minted" });
      return;
    }
    log("RELAY", `[${requestId}] On-chain hasMinted check passed`);

    // Build the ForwardRequest struct for the contract
    const forwardRequest = {
      from,
      to,
      value: BigInt(value),
      gas: BigInt(gas),
      deadline: Number(deadline),
      data,
      signature,
    };

    // Verify off-chain first
    log("RELAY", `[${requestId}] Verifying EIP-712 signature off-chain...`);
    const isValid = await forwarder.verify(forwardRequest);
    if (!isValid) {
      log("RELAY", `[${requestId}] REJECTED: signature verification failed`);
      res.status(400).json({ error: "Invalid forward request (signature verification failed)" });
      return;
    }
    log("RELAY", `[${requestId}] Signature verified OK`);

    // Execute on-chain (relayer pays gas)
    log("RELAY", `[${requestId}] Submitting tx to forwarder.execute()...`);
    // Explicit gas limit required — PolkaVM gas estimation is unreliable for forwarder calls
    const tx = await forwarder.execute(forwardRequest, { gasLimit: 1000000 });
    log("RELAY", `[${requestId}] Tx submitted: ${tx.hash}`);
    log("RELAY", `[${requestId}] Waiting for confirmation...`);
    const receipt = await tx.wait();
    log("RELAY", `[${requestId}] Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`);

    // Track
    relayedWallets.add(walletKey);
    totalRelayed++;

    log("RELAY", `[${requestId}] SUCCESS! Total relayed: ${totalRelayed}`);

    res.json({
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  } catch (e: any) {
    log("RELAY", `[${requestId}] ERROR:`, e.message);
    res.status(500).json({ error: "Relay failed: " + e.message });
  }
});

// --- Substrate Forwarder Routes ---

app.get("/api/substrate-nonce/:pubkey", async (req, res) => {
  const { pubkey } = req.params;
  log("SUB_NONCE", "Nonce requested for", pubkey);
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(pubkey)) {
      log("SUB_NONCE", "REJECTED: invalid pubkey format", pubkey);
      res.status(400).json({ error: "Invalid pubkey format (expected 0x + 64 hex chars)" });
      return;
    }
    const nonce = await substrateForwarder.substrateNonces(pubkey);
    log("SUB_NONCE", pubkey, "->", nonce.toString());
    res.json({ nonce: nonce.toString() });
  } catch (e: any) {
    log("SUB_NONCE", "ERROR:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/substrate-relay", relayLimiter, async (req, res) => {
  const requestId = Math.random().toString(36).slice(2, 8);
  log("SUB_RELAY", `[${requestId}] New substrate relay request received`);

  try {
    const { from, to, gas, deadline, data, signature } = req.body;
    if (!from || !to || !gas || !deadline || !data || !signature) {
      log("SUB_RELAY", `[${requestId}] REJECTED: missing fields`);
      res.status(400).json({ error: "Missing required fields: from, to, gas, deadline, data, signature" });
      return;
    }

    // Validate pubkey format
    if (!/^0x[0-9a-fA-F]{64}$/.test(from)) {
      log("SUB_RELAY", `[${requestId}] REJECTED: invalid pubkey format`);
      res.status(400).json({ error: "Invalid pubkey format (expected 0x + 64 hex chars)" });
      return;
    }

    log("SUB_RELAY", `[${requestId}] From (pubkey): ${from}`);
    log("SUB_RELAY", `[${requestId}] To: ${to}`);
    log("SUB_RELAY", `[${requestId}] Deadline: ${deadline}`);

    // Security: only allow calls to our TicketNFT
    if (to.toLowerCase() !== TICKET_NFT_ADDRESS.toLowerCase()) {
      log("SUB_RELAY", `[${requestId}] REJECTED: target ${to} not whitelisted`);
      res.status(403).json({ error: "Target contract not whitelisted" });
      return;
    }
    log("SUB_RELAY", `[${requestId}] Target contract whitelisted OK`);

    // Anti-spam: wallet dedup via derived H160
    const h160 = pubkeyToH160(from);
    log("SUB_RELAY", `[${requestId}] Derived H160: ${h160}`);
    const walletKey = h160.toLowerCase();
    if (relayedWallets.has(walletKey)) {
      log("SUB_RELAY", `[${requestId}] REJECTED: wallet ${h160} already relayed`);
      res.status(429).json({ error: "Already relayed for this wallet" });
      return;
    }
    log("SUB_RELAY", `[${requestId}] Wallet dedup check passed`);

    // Check on-chain hasMinted
    log("SUB_RELAY", `[${requestId}] Checking on-chain hasMinted for ${h160}...`);
    const alreadyMinted = await ticketNFT.hasMinted(h160);
    if (alreadyMinted) {
      log("SUB_RELAY", `[${requestId}] REJECTED: address ${h160} already minted on-chain`);
      res.status(409).json({ error: "Address has already minted" });
      return;
    }
    log("SUB_RELAY", `[${requestId}] On-chain hasMinted check passed`);

    // Convert signature hex to uint8[64] array
    const sigClean = signature.startsWith("0x") ? signature.slice(2) : signature;
    const sigArray: number[] = [];
    for (let i = 0; i < 128; i += 2) {
      sigArray.push(parseInt(sigClean.slice(i, i + 2), 16));
    }

    // Build the ForwardRequest struct
    const forwardRequest = {
      from,
      to,
      gas: BigInt(gas),
      deadline: Number(deadline),
      data,
      signature: sigArray,
    };

    // Verify off-chain first
    log("SUB_RELAY", `[${requestId}] Verifying sr25519 signature...`);
    const isValid = await substrateForwarder.verify(forwardRequest);
    if (!isValid) {
      log("SUB_RELAY", `[${requestId}] REJECTED: signature verification failed`);
      res.status(400).json({ error: "Invalid forward request (signature verification failed)" });
      return;
    }
    log("SUB_RELAY", `[${requestId}] Signature verified OK`);

    // Execute on-chain (relayer pays gas)
    log("SUB_RELAY", `[${requestId}] Submitting tx to substrateForwarder.execute()...`);
    const tx = await substrateForwarder.execute(forwardRequest, { gasLimit: 5_000_000_000 });
    log("SUB_RELAY", `[${requestId}] Tx submitted: ${tx.hash}`);
    log("SUB_RELAY", `[${requestId}] Waiting for confirmation...`);
    const receipt = await tx.wait();
    log("SUB_RELAY", `[${requestId}] Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`);

    // Track
    relayedWallets.add(walletKey);
    totalRelayed++;

    log("SUB_RELAY", `[${requestId}] SUCCESS! Total relayed: ${totalRelayed}`);

    res.json({
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
    });
  } catch (e: any) {
    log("SUB_RELAY", `[${requestId}] ERROR:`, e.message);
    res.status(500).json({ error: "Relay failed: " + e.message });
  }
});

// --- Config endpoint for frontend ---
app.get("/api/config", (_req, res) => {
  log("CONFIG", "Config requested");
  res.json({
    forwarderAddress: FORWARDER_ADDRESS,
    substrateForwarderAddress: SUBSTRATE_FORWARDER_ADDRESS,
    ticketNFTAddress: TICKET_NFT_ADDRESS,
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
  });
});

app.listen(PORT, async () => {
  log("STARTUP", "=== Relay Server Starting ===");
  log("STARTUP", `URL: http://localhost:${PORT}`);
  log("STARTUP", `Relayer: ${relayer.address}`);
  log("STARTUP", `Forwarder (EVM): ${FORWARDER_ADDRESS}`);
  log("STARTUP", `Forwarder (Substrate): ${SUBSTRATE_FORWARDER_ADDRESS}`);
  log("STARTUP", `TicketNFT: ${TICKET_NFT_ADDRESS}`);
  log("STARTUP", `Chain ID: ${CHAIN_ID}`);
  log("STARTUP", `RPC: ${RPC_URL}`);
  try {
    const balance = await provider.getBalance(relayer.address);
    log("STARTUP", `Relayer balance: ${ethers.formatEther(balance)} PAS`);
    const totalMinted = await ticketNFT.totalMinted();
    const maxSupply = await ticketNFT.maxSupply();
    log("STARTUP", `Minted so far: ${totalMinted}/${maxSupply}`);
  } catch (e: any) {
    log("STARTUP", "WARNING: Could not fetch on-chain state:", e.message);
  }
  log("STARTUP", "=== Ready ===");
});
