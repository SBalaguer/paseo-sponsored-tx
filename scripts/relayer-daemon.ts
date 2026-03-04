/**
 * Relayer Daemon — Statement Store Transport
 *
 * Subscribes to People Chain's statement store for meta-tx requests,
 * verifies and executes them on Asset Hub via the forwarder contracts.
 *
 * Also exposes POST /submit for proxy fallback (Path B):
 * wraps incoming meta-tx in a statement signed by the proxy account.
 */

import * as http from "http";
import { ethers } from "ethers";
import * as dotenv from "dotenv";
import {
  createPeopleChainClient,
  createProxySigner,
  submitRawStatement,
  subscribeMetaTxStatements,
  MetaTxRequest,
} from "../lib/statement-store";

dotenv.config();

// --- Config ---

const PEOPLE_WS_URI =
  process.env.PEOPLE_WS_URI || "wss://previewnet.substrate.dev/people";
const ASSET_HUB_ETH_RPC =
  process.env.ASSET_HUB_ETH_RPC || "https://previewnet.substrate.dev/eth-rpc";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY!;
const PROXY_SEED = process.env.PROXY_SEED || "//Alice";
const FORWARDER_ADDRESS = process.env.FORWARDER_ADDRESS!;
const SUBSTRATE_FORWARDER_ADDRESS = process.env.SUBSTRATE_FORWARDER_ADDRESS!;
const TICKET_NFT_ADDRESS = process.env.TICKET_NFT_ADDRESS!;
const DAEMON_PORT = parseInt(process.env.DAEMON_PORT || process.env.PORT || "3001", 10);

if (
  !DEPLOYER_PRIVATE_KEY ||
  !FORWARDER_ADDRESS ||
  !SUBSTRATE_FORWARDER_ADDRESS ||
  !TICKET_NFT_ADDRESS
) {
  console.error(
    "Missing required env vars: DEPLOYER_PRIVATE_KEY, FORWARDER_ADDRESS, SUBSTRATE_FORWARDER_ADDRESS, TICKET_NFT_ADDRESS",
  );
  process.exit(1);
}

// --- Logging ---

function log(tag: string, ...args: any[]) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${tag}]`, ...args);
}

// --- Asset Hub provider & signer ---

const provider = new ethers.JsonRpcProvider(ASSET_HUB_ETH_RPC);
const relayerWallet = new ethers.Wallet(DEPLOYER_PRIVATE_KEY, provider);

// --- Contract ABIs (minimal) ---

const FORWARDER_ABI = [
  "function nonces(address owner) view returns (uint256)",
  "function verify((address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature) request) view returns (bool)",
  "function execute((address from, address to, uint256 value, uint256 gas, uint48 deadline, bytes data, bytes signature) request) payable",
];

const SUBSTRATE_FORWARDER_ABI = [
  "function substrateNonces(bytes32 pubkey) view returns (uint256)",
  "function verify((bytes32 from, address to, uint256 gas, uint48 deadline, bytes data, uint8[64] signature) request) view returns (bool)",
  "function execute((bytes32 from, address to, uint256 gas, uint48 deadline, bytes data, uint8[64] signature) request)",
  "function toH160(bytes32 accountId) view returns (address)",
];

const TICKET_NFT_ABI = [
  "function hasMinted(address) view returns (bool)",
];

const forwarder = new ethers.Contract(
  FORWARDER_ADDRESS,
  FORWARDER_ABI,
  relayerWallet,
);
const substrateForwarder = new ethers.Contract(
  SUBSTRATE_FORWARDER_ADDRESS,
  SUBSTRATE_FORWARDER_ABI,
  relayerWallet,
);
const ticketNFT = new ethers.Contract(
  TICKET_NFT_ADDRESS,
  TICKET_NFT_ABI,
  provider,
);

// --- SSE infrastructure ---

const sseClients: http.ServerResponse[] = [];

function broadcastSSE(event: string, data: Record<string, any>) {
  const payload = `event: ${event}\ndata: ${JSON.stringify({ ...data, timestamp: new Date().toISOString() })}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    try {
      sseClients[i].write(payload);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

// --- State ---

const processedHashes = new Set<string>();
let processing = false;
const pendingQueue: Array<{ metaTx: MetaTxRequest; key: string }> = [];
let processedCount = 0;

// --- Helpers ---

function correlationId(metaTx: MetaTxRequest): string {
  return `${metaTx.type}:${metaTx.from}:${metaTx.deadline}`;
}

// --- Meta-tx execution ---

async function executeMetaTx(metaTx: MetaTxRequest): Promise<void> {
  const cid = correlationId(metaTx);
  const requestId = Math.random().toString(36).slice(2, 8);
  log("EXEC", `[${requestId}] Processing ${metaTx.type} meta-tx from ${metaTx.from}`);

  // Validate target contract whitelist
  if (metaTx.to.toLowerCase() !== TICKET_NFT_ADDRESS.toLowerCase()) {
    log("EXEC", `[${requestId}] REJECTED: target ${metaTx.to} not whitelisted`);
    broadcastSSE("tx:failed", { correlationId: cid, reason: "target not whitelisted", from: metaTx.from });
    return;
  }

  // Check deadline
  const now = Math.floor(Date.now() / 1000);
  if (parseInt(metaTx.deadline) < now) {
    log("EXEC", `[${requestId}] REJECTED: deadline expired`);
    broadcastSSE("tx:failed", { correlationId: cid, reason: "deadline expired", from: metaTx.from });
    return;
  }

  // Pre-check: has this user already minted? (saves gas on replayed statements)
  try {
    let minterAddress: string;
    if (metaTx.type === "sr25519") {
      minterAddress = await substrateForwarder.toH160(metaTx.from);
    } else {
      minterAddress = metaTx.from;
    }
    const alreadyMinted = await ticketNFT.hasMinted(minterAddress);
    if (alreadyMinted) {
      log("EXEC", `[${requestId}] REJECTED: already minted (${minterAddress})`);
      broadcastSSE("tx:failed", { correlationId: cid, reason: "already minted", from: metaTx.from });
      return;
    }
  } catch (e: any) {
    log("EXEC", `[${requestId}] hasMinted check failed, proceeding: ${e.message}`);
  }

  try {
    if (metaTx.type === "ecdsa") {
      await executeEcdsaMetaTx(metaTx, requestId, cid);
    } else if (metaTx.type === "sr25519") {
      await executeSr25519MetaTx(metaTx, requestId, cid);
    }
    processedCount++;
  } catch (err: any) {
    log("EXEC", `[${requestId}] ERROR: ${err.message}`);
    broadcastSSE("tx:failed", { correlationId: cid, reason: err.message, from: metaTx.from });
  }
}

async function executeEcdsaMetaTx(
  metaTx: MetaTxRequest,
  requestId: string,
  cid: string,
): Promise<void> {
  const forwardRequest = {
    from: metaTx.from,
    to: metaTx.to,
    value: BigInt(metaTx.value || "0"),
    gas: BigInt(metaTx.gas),
    deadline: Number(metaTx.deadline),
    data: metaTx.data,
    signature: metaTx.signature,
  };

  log("EXEC", `[${requestId}] Verifying EIP-712 signature...`);
  broadcastSSE("tx:verifying", { correlationId: cid, from: metaTx.from, type: "ecdsa" });
  const isValid = await forwarder.verify(forwardRequest);
  if (!isValid) {
    log("EXEC", `[${requestId}] REJECTED: signature verification failed`);
    broadcastSSE("tx:failed", { correlationId: cid, reason: "signature verification failed", from: metaTx.from });
    return;
  }

  log("EXEC", `[${requestId}] Executing via forwarder...`);
  // Populate, sign, and compute hash before broadcasting so we always have the tx hash
  const contractTx = await forwarder.execute.populateTransaction(forwardRequest, { gasLimit: 1_000_000 });
  const populatedTx = await relayerWallet.populateTransaction(contractTx);
  const signedTx = await relayerWallet.signTransaction(populatedTx);
  const txHash = ethers.keccak256(signedTx);
  try {
    await provider.broadcastTransaction(signedTx);
  } catch (sendErr: any) {
    if (!sendErr.message?.includes("Transaction Already Imported")) throw sendErr;
    log("EXEC", `[${requestId}] Tx accepted (Already Imported) — hash: ${txHash}`);
  }
  log("EXEC", `[${requestId}] Tx submitted: ${txHash}`);
  broadcastSSE("tx:submitted", { correlationId: cid, txHash, from: metaTx.from });
  const receipt = await provider.waitForTransaction(txHash, 1, 180_000);
  if (receipt!.status === 0) {
    log("EXEC", `[${requestId}] REVERTED in block ${receipt!.blockNumber}`);
    broadcastSSE("tx:failed", { correlationId: cid, txHash, reason: "transaction reverted on-chain", from: metaTx.from });
    return;
  }
  log(
    "EXEC",
    `[${requestId}] Confirmed block ${receipt!.blockNumber}, gas ${receipt!.gasUsed}`,
  );
  broadcastSSE("tx:confirmed", { correlationId: cid, txHash, blockNumber: receipt!.blockNumber, gasUsed: receipt!.gasUsed.toString(), from: metaTx.from });
}

async function executeSr25519MetaTx(
  metaTx: MetaTxRequest,
  requestId: string,
  cid: string,
): Promise<void> {
  // Convert signature hex to uint8[64] array
  const sigClean = metaTx.signature.startsWith("0x")
    ? metaTx.signature.slice(2)
    : metaTx.signature;
  const sigArray: number[] = [];
  for (let i = 0; i < 128; i += 2) {
    sigArray.push(parseInt(sigClean.slice(i, i + 2), 16));
  }

  const forwardRequest = {
    from: metaTx.from,
    to: metaTx.to,
    gas: BigInt(metaTx.gas),
    deadline: Number(metaTx.deadline),
    data: metaTx.data,
    signature: sigArray,
  };

  log("EXEC", `[${requestId}] Verifying sr25519 signature...`);
  broadcastSSE("tx:verifying", { correlationId: cid, from: metaTx.from, type: "sr25519" });
  const isValid = await substrateForwarder.verify(forwardRequest);
  if (!isValid) {
    log("EXEC", `[${requestId}] REJECTED: signature verification failed`);
    broadcastSSE("tx:failed", { correlationId: cid, reason: "signature verification failed", from: metaTx.from });
    return;
  }

  log("EXEC", `[${requestId}] Executing via substrateForwarder...`);
  // Populate, sign, and compute hash before broadcasting so we always have the tx hash
  const contractTx = await substrateForwarder.execute.populateTransaction(forwardRequest, {
    gasLimit: 5_000_000_000,
  });
  const populatedTx = await relayerWallet.populateTransaction(contractTx);
  const signedTx = await relayerWallet.signTransaction(populatedTx);
  const txHash = ethers.keccak256(signedTx);
  try {
    await provider.broadcastTransaction(signedTx);
  } catch (sendErr: any) {
    if (!sendErr.message?.includes("Transaction Already Imported")) throw sendErr;
    log("EXEC", `[${requestId}] Tx accepted (Already Imported) — hash: ${txHash}`);
  }
  log("EXEC", `[${requestId}] Tx submitted: ${txHash}`);
  broadcastSSE("tx:submitted", { correlationId: cid, txHash, from: metaTx.from });
  const receipt = await provider.waitForTransaction(txHash, 1, 180_000);
  if (receipt!.status === 0) {
    log("EXEC", `[${requestId}] REVERTED in block ${receipt!.blockNumber}`);
    broadcastSSE("tx:failed", { correlationId: cid, txHash, reason: "transaction reverted on-chain", from: metaTx.from });
    return;
  }
  log(
    "EXEC",
    `[${requestId}] Confirmed block ${receipt!.blockNumber}, gas ${receipt!.gasUsed}`,
  );
  broadcastSSE("tx:confirmed", { correlationId: cid, txHash, blockNumber: receipt!.blockNumber, gasUsed: receipt!.gasUsed.toString(), from: metaTx.from });
}

// --- Process queue sequentially ---

async function processQueue() {
  if (processing) return;
  processing = true;

  while (pendingQueue.length > 0) {
    const item = pendingQueue.shift()!;
    await executeMetaTx(item.metaTx);
  }

  processing = false;
}

// --- HTTP server for /submit (Path B proxy fallback) ---

function startHttpServer(
  client: ReturnType<typeof createPeopleChainClient>["client"],
  proxySigner: ReturnType<typeof createProxySigner>,
) {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // SSE endpoint
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("event: connected\ndata: {}\n\n");
      sseClients.push(res);
      req.on("close", () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
      });
      return;
    }

    if (req.method === "POST" && req.url === "/submit") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", async () => {
        try {
          const metaTx: MetaTxRequest = JSON.parse(body);

          // Validate required fields
          if (
            !metaTx.type ||
            !metaTx.from ||
            !metaTx.to ||
            !metaTx.gas ||
            !metaTx.deadline ||
            !metaTx.data ||
            !metaTx.signature
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required fields" }));
            return;
          }

          log("HTTP", `POST /submit — ${metaTx.type} from ${metaTx.from}`);

          // Submit as statement via proxy signer (custom encoder with u64 priority)
          const result = await submitRawStatement(client._request, proxySigner, metaTx);

          log("HTTP", `Statement submit result: ${result.status}`);

          const cid = correlationId(metaTx);

          if (result.status === "new" || result.status === "known") {
            broadcastSSE("statement:submitted", { correlationId: cid, from: metaTx.from, type: metaTx.type, status: result.status });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: result.status, correlationId: cid }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Statement rejected", details: result }));
          }
        } catch (err: any) {
          log("HTTP", `Error: ${err.message}`);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      try {
        const balance = await provider.getBalance(relayerWallet.address);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            relayer: relayerWallet.address,
            balance: ethers.formatEther(balance),
            proxy: proxySigner.ss58,
            processed: processedHashes.size,
          }),
        );
      } catch (err: any) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", message: err.message }));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(DAEMON_PORT, "0.0.0.0", () => {
    log("HTTP", `Listening on http://0.0.0.0:${DAEMON_PORT}`);
    log("HTTP", `POST /submit  — proxy statement submission`);
    log("HTTP", `GET  /events  — SSE event stream`);
    log("HTTP", `GET  /health  — daemon health check`);
  });

  return server;
}

// --- Main ---

async function main() {
  log("STARTUP", "=== Relayer Daemon Starting ===");
  log("STARTUP", `People Chain WS: ${PEOPLE_WS_URI}`);
  log("STARTUP", `Asset Hub RPC: ${ASSET_HUB_ETH_RPC}`);
  log("STARTUP", `Relayer (ECDSA): ${relayerWallet.address}`);
  log("STARTUP", `Forwarder (EVM): ${FORWARDER_ADDRESS}`);
  log("STARTUP", `Forwarder (Substrate): ${SUBSTRATE_FORWARDER_ADDRESS}`);
  log("STARTUP", `TicketNFT: ${TICKET_NFT_ADDRESS}`);

  // Initialize People Chain client & SDK
  log("STARTUP", "Connecting to People Chain...");
  const { client, sdk } = createPeopleChainClient(PEOPLE_WS_URI);

  // Initialize proxy signer
  const proxySigner = createProxySigner(PROXY_SEED);
  log("STARTUP", `Proxy account (sr25519): ${proxySigner.ss58}`);

  // Check relayer balance
  try {
    const balance = await provider.getBalance(relayerWallet.address);
    log("STARTUP", `Relayer balance: ${ethers.formatEther(balance)}`);
  } catch (err: any) {
    log("STARTUP", `WARNING: Could not fetch balance: ${err.message}`);
  }

  // Start HTTP server for Path B
  startHttpServer(client, proxySigner);

  // Subscribe to People Chain statement store
  log("STARTUP", "Subscribing to statement store...");
  const stopSubscription = subscribeMetaTxStatements(
    PEOPLE_WS_URI,
    (metaTx) => {
      const key = `${metaTx.type}:${metaTx.from}:${metaTx.deadline}`;
      if (processedHashes.has(key)) {
        return;
      }
      processedHashes.add(key);

      const cid = correlationId(metaTx);
      log("SUB", `New meta-tx: ${metaTx.type} from ${metaTx.from}`);
      broadcastSSE("statement:received", { correlationId: cid, from: metaTx.from, type: metaTx.type });
      pendingQueue.push({ metaTx, key });
      processQueue();
    },
  );

  log("STARTUP", "=== Relayer Daemon Ready ===");

  // Heartbeat every 30s
  const heartbeatInterval = setInterval(async () => {
    try {
      const balance = await provider.getBalance(relayerWallet.address);
      broadcastSSE("daemon:health", {
        balance: ethers.formatEther(balance),
        processedCount,
        queueLength: pendingQueue.length,
        relayer: relayerWallet.address,
      });
    } catch {
      // Ignore balance fetch errors in heartbeat
    }
  }, 30_000);

  // Graceful shutdown
  const shutdown = () => {
    log("SHUTDOWN", "Stopping...");
    clearInterval(heartbeatInterval);
    stopSubscription();
    client.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
