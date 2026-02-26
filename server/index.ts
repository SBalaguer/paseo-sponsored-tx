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
const TICKET_NFT_ADDRESS = process.env.TICKET_NFT_ADDRESS!;
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY!;

if (!FORWARDER_ADDRESS || !TICKET_NFT_ADDRESS || !DEPLOYER_PRIVATE_KEY) {
  console.error("Missing required env vars: FORWARDER_ADDRESS, TICKET_NFT_ADDRESS, DEPLOYER_PRIVATE_KEY");
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

const forwarder = new ethers.Contract(FORWARDER_ADDRESS, FORWARDER_ABI, relayer);
const ticketNFT = new ethers.Contract(TICKET_NFT_ADDRESS, TICKET_ABI, provider);

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

// --- Config endpoint for frontend ---
app.get("/api/config", (_req, res) => {
  log("CONFIG", "Config requested");
  res.json({
    forwarderAddress: FORWARDER_ADDRESS,
    ticketNFTAddress: TICKET_NFT_ADDRESS,
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
  });
});

app.listen(PORT, async () => {
  log("STARTUP", "=== Relay Server Starting ===");
  log("STARTUP", `URL: http://localhost:${PORT}`);
  log("STARTUP", `Relayer: ${relayer.address}`);
  log("STARTUP", `Forwarder: ${FORWARDER_ADDRESS}`);
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
