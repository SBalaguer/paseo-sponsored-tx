import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import {
  createStatementSdk,
  stringToTopic,
} from "@polkadot-api/sdk-statement";
import type { SubmitResult } from "@polkadot-api/sdk-statement";
import {
  DEV_PHRASE,
  sr25519,
  sr25519Derive,
  createDerive,
  mnemonicToMiniSecret,
  parseSuri,
  ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import WebSocket from "ws";

// --- Constants ---

export const TOPIC = "sponsored-tx";

// The node uses u64 for priority. High 32 bits = expiry block (0xFFFFFFFF = never).
// Low 32 bits = priority value.
const PRIORITY_NEVER_EXPIRE = BigInt("0xFFFFFFFF00000001");

// --- Types ---

export interface MetaTxRequest {
  type: "ecdsa" | "sr25519";
  from: string;
  to: string;
  gas: string;
  deadline: string;
  data: string;
  signature: string;
  /** Only for ecdsa: ERC2771 value field */
  value?: string;
}

// --- Client / SDK creation ---

export function createPeopleChainClient(wsUri: string) {
  const provider = getWsProvider(wsUri);
  const client = createClient(provider);
  const sdk = createStatementSdk(client._request);
  return { client, sdk };
}

// --- Signer creation ---

/**
 * Create a statement signer from a SURI (e.g. "//Alice" or a mnemonic + path).
 * Uses sr25519 curve.
 */
export function createProxySigner(seed: string) {
  // Handle shorthand like "//Alice" → prepend DEV_PHRASE
  const suri = seed.startsWith("//") ? DEV_PHRASE + seed : seed;
  const parsed = parseSuri(suri);
  const phrase = parsed.phrase || DEV_PHRASE;
  const miniSecret = mnemonicToMiniSecret(phrase, parsed.password);

  const derive = createDerive({
    seed: miniSecret,
    curve: sr25519,
    derive: sr25519Derive,
  });

  const keyPair = derive(parsed.paths || "");
  const ss58 = ss58Address(keyPair.publicKey, 0);

  return {
    publicKey: keyPair.publicKey,
    sign: (payload: Uint8Array) => keyPair.sign(payload),
    ss58,
  };
}

// --- Custom SCALE encoder ---
// The SDK uses u32 for priority, but the node expects u64.
// We bypass the SDK's codec and encode statements manually.

// Field variant discriminants (matching Substrate's Field enum):
const FIELD_PROOF = 0;
const FIELD_PRIORITY = 2;
const FIELD_TOPIC1 = 4;
const FIELD_DATA = 8;

// Proof sub-variant:
const PROOF_SR25519 = 0;

function encodeCompact(value: number): Uint8Array {
  if (value < 64) return new Uint8Array([(value << 2)]);
  if (value < 16384) {
    const v = (value << 2) | 1;
    return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  }
  const v = (value << 2) | 2;
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
}

function encodeU64LE(value: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    buf[i] = Number((value >> BigInt(i * 8)) & BigInt(0xff));
  }
  return buf;
}

/**
 * Encode unsigned fields (priority + topic + data) into SCALE bytes.
 * Returns the full Vec<Field> encoding (compact length prefix + field bytes).
 */
function encodeUnsignedFields(
  topicHash: string,
  data: Uint8Array,
  priority: bigint = PRIORITY_NEVER_EXPIRE,
): Uint8Array {
  const topicBytes = hexToUint8Array(topicHash);
  const dataLenCompact = encodeCompact(data.length);

  // 3 fields: priority, topic1, data
  const fieldCount = encodeCompact(3);

  // Field: Priority (variant 2, u64 LE)
  const priorityField = new Uint8Array(1 + 8);
  priorityField[0] = FIELD_PRIORITY;
  priorityField.set(encodeU64LE(priority), 1);

  // Field: Topic1 (variant 4, 32 bytes)
  const topicField = new Uint8Array(1 + 32);
  topicField[0] = FIELD_TOPIC1;
  topicField.set(topicBytes, 1);

  // Field: Data (variant 8, compact-len + bytes)
  const dataField = new Uint8Array(1 + dataLenCompact.length + data.length);
  dataField[0] = FIELD_DATA;
  dataField.set(dataLenCompact, 1);
  dataField.set(data, 1 + dataLenCompact.length);

  // Concatenate: compact(3) + priority + topic + data
  const total = fieldCount.length + priorityField.length + topicField.length + dataField.length;
  const result = new Uint8Array(total);
  let off = 0;
  result.set(fieldCount, off); off += fieldCount.length;
  result.set(priorityField, off); off += priorityField.length;
  result.set(topicField, off); off += topicField.length;
  result.set(dataField, off);

  return result;
}

/**
 * Build and sign a statement with the correct u64 priority encoding.
 * Returns the hex-encoded signed statement ready for statement_submit.
 */
function signAndEncode(
  publicKey: Uint8Array,
  signFn: (payload: Uint8Array) => Uint8Array,
  topicHash: string,
  data: Uint8Array,
): string {
  // 1. Encode unsigned fields
  const unsignedEncoded = encodeUnsignedFields(topicHash, data);

  // 2. Extract fields bytes (after compact vec length prefix)
  // The compact prefix for 3 is a single byte (0x0c), so fields start at offset 1
  const compactPrefixLen = encodeCompact(3).length;
  const fieldsBytes = unsignedEncoded.slice(compactPrefixLen);

  // 3. Sign the fields bytes (this is what the node verifies)
  const signature = signFn(fieldsBytes);

  // 4. Build proof field: variant 0 (AuthenticityProof), sub-variant 0 (sr25519)
  //    signature (64 bytes) + signer (32 bytes)
  const proofField = new Uint8Array(1 + 1 + 64 + 32);
  proofField[0] = FIELD_PROOF;
  proofField[1] = PROOF_SR25519;
  proofField.set(signature.slice(0, 64), 2);
  proofField.set(publicKey.slice(0, 32), 66);

  // 5. Encode full signed statement: compact(4 fields) + proof + priority + topic + data
  const signedFieldCount = encodeCompact(4);
  const total = signedFieldCount.length + proofField.length + fieldsBytes.length;
  const result = new Uint8Array(total);
  let off = 0;
  result.set(signedFieldCount, off); off += signedFieldCount.length;
  result.set(proofField, off); off += proofField.length;
  result.set(fieldsBytes, off);

  return "0x" + uint8ArrayToHex(result);
}

// --- Statement submission ---

export async function submitMetaTx(
  sdk: ReturnType<typeof createStatementSdk>,
  proxySigner: ReturnType<typeof createProxySigner>,
  metaTx: MetaTxRequest,
): Promise<SubmitResult> {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(metaTx));
  const topicHash = stringToTopic(TOPIC);

  // Use custom encoder with u64 priority (bypassing SDK's u32 codec)
  const hex = signAndEncode(proxySigner.publicKey, proxySigner.sign, topicHash, jsonBytes);

  // Submit via the SDK's request function (which calls statement_submit)
  return sdk.submit({ __raw_hex: hex } as any);
}

/**
 * Submit a raw hex-encoded statement via the SDK's underlying request function.
 * We need this because sdk.submit() re-encodes with the wrong codec.
 */
export async function submitRawStatement(
  requestFn: (method: string, params: any[]) => Promise<any>,
  proxySigner: ReturnType<typeof createProxySigner>,
  metaTx: MetaTxRequest,
): Promise<SubmitResult> {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(metaTx));
  const topicHash = stringToTopic(TOPIC);

  const hex = signAndEncode(proxySigner.publicKey, proxySigner.sign, topicHash, jsonBytes);

  // Call statement_submit directly, bypassing the SDK's codec
  const result = await requestFn("statement_submit", [hex]);
  return result ?? { status: "new" };
}

// --- Statement subscription ---

/**
 * Subscribe to new statements via statement_subscribeStatement WebSocket RPC.
 * Uses topic filtering with matchAll for our sponsored-tx topic.
 * Calls `callback` for each new meta-tx statement (deduplicates).
 * Returns a cleanup function.
 */
export function subscribeMetaTxStatements(
  wsUri: string,
  callback: (metaTx: MetaTxRequest) => void,
): () => void {
  const seen = new Set<string>();
  let ws: WebSocket | null = null;
  let alive = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const topicHash = stringToTopic(TOPIC);

  function connect() {
    if (!alive) return;

    ws = new WebSocket(wsUri);

    ws.on("open", () => {
      console.log("[statement-store] WS connected, subscribing...");
      ws!.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "statement_subscribeStatement",
          params: [{ matchAll: [topicHash] }],
          id: 1,
        }),
      );
    });

    ws.on("message", (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());

        // Subscription confirmation
        if (msg.id === 1) {
          if (msg.error) {
            console.error("[statement-store] Subscription error:", msg.error);
          } else {
            console.log("[statement-store] Subscribed, id:", msg.result);
          }
          return;
        }

        // Subscription notification
        if (msg.method === "statement_statement" && msg.params?.result) {
          const event = msg.params.result;
          if (event.event === "newStatements" && event.data?.statements) {
            for (const hexStmt of event.data.statements) {
              processStatement(hexStmt, seen, callback);
            }
          }
        }
      } catch (err) {
        console.error("[statement-store] Message parse error:", err);
      }
    });

    ws.on("close", () => {
      console.log("[statement-store] WS disconnected");
      if (alive) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    });

    ws.on("error", (err: Error) => {
      console.error("[statement-store] WS error:", err.message);
    });
  }

  connect();

  return () => {
    alive = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
  };
}

// --- Parsing ---

export function parseMetaTxData(data: Uint8Array): MetaTxRequest | null {
  try {
    const text = new TextDecoder().decode(data);
    const obj = JSON.parse(text);

    if (
      !obj.type ||
      !obj.from ||
      !obj.to ||
      !obj.gas ||
      !obj.deadline ||
      !obj.data ||
      !obj.signature
    ) {
      return null;
    }

    if (obj.type !== "ecdsa" && obj.type !== "sr25519") {
      return null;
    }

    return obj as MetaTxRequest;
  } catch {
    return null;
  }
}

// --- Helpers ---

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const arr = new Uint8Array(clean.length / 2);
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Decode a raw SCALE-encoded statement (with u64 priority) and extract the Data field.
 */
function decodeStatementData(bytes: Uint8Array): Uint8Array | null {
  let off = 0;

  // Compact vec length
  const firstByte = bytes[off];
  let vecLen: number;
  if ((firstByte & 3) === 0) { vecLen = firstByte >> 2; off += 1; }
  else if ((firstByte & 3) === 1) { vecLen = (bytes[off] | (bytes[off + 1] << 8)) >> 2; off += 2; }
  else return null;

  for (let f = 0; f < vecLen && off < bytes.length; f++) {
    const variant = bytes[off]; off++;

    if (variant === 0) { // Proof
      const pv = bytes[off]; off++;
      if (pv === 0 || pv === 1) off += 64 + 32; // sr25519 or ed25519
      else if (pv === 2) off += 65 + 33; // ecdsa
      else if (pv === 3) off += 32 + 32 + 8; // onChain
      else return null;
    } else if (variant === 1 || variant === 3) { // DecryptionKey or Channel
      off += 32;
    } else if (variant === 2) { // Priority (u64!)
      off += 8;
    } else if (variant >= 4 && variant <= 7) { // Topic1-4
      off += 32;
    } else if (variant === 8) { // Data
      const fb = bytes[off];
      let dataLen: number, compactSize: number;
      if ((fb & 3) === 0) { dataLen = fb >> 2; compactSize = 1; }
      else if ((fb & 3) === 1) { dataLen = (bytes[off] | (bytes[off + 1] << 8)) >> 2; compactSize = 2; }
      else if ((fb & 3) === 2) {
        dataLen = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >> 2;
        compactSize = 4;
      } else return null;
      off += compactSize;
      return bytes.slice(off, off + dataLen);
    } else {
      return null; // Unknown variant
    }
  }
  return null;
}

function processStatement(
  hexStmt: string,
  seen: Set<string>,
  callback: (metaTx: MetaTxRequest) => void,
) {
  try {
    const bytes = hexToUint8Array(hexStmt);
    const data = decodeStatementData(bytes);
    if (!data) return;

    const parsed = parseMetaTxData(data);
    if (!parsed) return;

    // Deduplicate
    const key = `${parsed.type}:${parsed.from}:${parsed.deadline}:${parsed.signature.slice(0, 20)}`;
    if (seen.has(key)) return;
    seen.add(key);

    callback(parsed);
  } catch {
    // Not a valid statement or not our format — skip silently
  }
}
