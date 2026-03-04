# Statement Store as a Transport Layer

## Problem

The original architecture uses a centralized HTTP relay server as the single point of contact between users and the on-chain forwarder contracts. If the relay goes down, no meta-transactions can be processed. This is a single point of failure.

## What is the Statement Store

The **Statement Store** is Substrate's built-in off-chain P2P gossip layer. It consists of three components:

- **`sc-statement-store`** — the client-side statement store that manages storage, validation, and replication
- **`sc-network-statement`** — the networking layer that gossips statements across connected nodes via libp2p
- **`pallet-statement`** — the on-chain pallet that manages statement allowances based on account balances

Statements are arbitrary data blobs that propagate across all connected nodes in the network. Each node maintains a local store of statements and replicates new ones to peers. This provides a decentralized, censorship-resistant data availability layer without requiring on-chain transactions for the data itself.

## How We Use It

We use statements as a **transport layer for meta-transaction requests**. The flow:

1. A signed meta-tx request (the application payload) is JSON-encoded
2. The JSON bytes are placed in the `data` field of a SCALE-encoded statement
3. The statement is signed and submitted to People Chain via `statement_submit`
4. The statement gossips across People Chain nodes via libp2p
5. Any relayer daemon polling the statement store picks it up
6. The daemon decodes the meta-tx, verifies it, and executes it on Asset Hub

```
                         People Chain (Statement Store)
                              ↑              ↓
                    statement_submit    sdk.getStatements()
                              ↑              ↓
   ┌──────────┐         ┌─────────┐    ┌──────────────┐    ┌───────────┐
   │ Frontend  │──Path A→│ People  │    │   Relayer    │───→│ Asset Hub │
   │ (browser) │         │ Chain   │    │   Daemon     │    │ (eth-rpc) │
   │           │──Path B─────────────→──│ POST /submit │    │           │
   └──────────┘         └─────────┘    └──────────────┘    └───────────┘
        │                                    ↑
        │ (config, nonces,             Picks up statements,
        │  contract calls              verifies meta-tx,
        │  go direct to RPC)           executes via forwarder
        └──→ Asset Hub eth-rpc
```

## Statement SCALE Format

A statement is a `Vec<Field>` where each field has a discriminant tag:

| Tag | Field | Description |
|-----|-------|-------------|
| 0 | AuthenticityProof | Signature proof (sr25519/ed25519/ecdsa/onChain) |
| 1 | DecryptionKey | Optional 32-byte decryption key |
| 2 | Priority | u32 priority value |
| 3 | Channel | Optional 32-byte channel identifier |
| 4 | Topic | 32-byte topic hash (up to 4 topics per statement) |
| 8 | Data | Arbitrary bytes (the payload) |

When signing, the proof field (tag 0) is omitted from the signing material — the signer signs over the remaining fields.

The **`@polkadot-api/sdk-statement`** SDK handles all SCALE encoding internally. Application code works with a TypeScript `Statement` object:

```ts
type Statement = Partial<{
  proof: Proof;
  decryptionKey: SizedHex<32>;
  priority: number;
  channel: SizedHex<32>;
  topics: Array<SizedHex<32>>;
  data: Uint8Array;
}>;
```

## Data Payload Format

The application payload (the `data` field) is JSON for simplicity and debuggability:

```json
{
  "type": "ecdsa" | "sr25519",
  "from": "0x...",
  "to": "0x...",
  "gas": "500000",
  "deadline": "1234567890",
  "data": "0x...",
  "signature": "0x...",
  "value": "0"
}
```

## Topic Filtering

Statements are tagged with topics for efficient filtering. We use:

```ts
import { stringToTopic } from "@polkadot-api/sdk-statement";

const topic = stringToTopic("sponsored-tx"); // → SizedHex<32>
```

The relayer daemon queries only statements matching this topic:

```ts
const statements = await sdk.getStatements({
  topics: [stringToTopic("sponsored-tx")]
});
```

## Two Submission Paths

### Path A: Direct (User Wallet)

The user has a Polkadot wallet with balance on People Chain. The frontend (or a bundled SDK) creates and signs a statement directly, submitting it to People Chain via WebSocket RPC.

**Requirement**: The user's account must have sufficient balance on People Chain for statement allowance (see below).

### Path B: Proxy Fallback

The user has no balance on People Chain (e.g., MetaMask-only users). The meta-tx request is POSTed to the relayer daemon's `/submit` HTTP endpoint. The daemon wraps it in a statement signed by a funded **proxy account** (configurable via `PROXY_SEED` env var) and submits to People Chain.

In both paths, the inner meta-tx signature (ECDSA EIP-712 or sr25519) proves the user authorized the action. The statement signature only proves who submitted the envelope to the gossip network.

## Statement Allowance

The statement store uses a balance-based gating mechanism. Each account's **statement allowance** is derived from their on-chain balance on People Chain:

- Accounts with zero balance cannot submit statements
- Higher balances allow more/larger statements
- The allowance determines maximum data size and number of statements per account

This is why the **proxy account** exists: MetaMask users or users without People Chain balance need a funded account to sign the statement envelope. The proxy account's balance must be maintained to continue submitting statements.

## RPC API

- **`statement_submit(encoded: Bytes)`** — Submit a SCALE-encoded signed statement to the local node. The node validates it and gossips to peers.
- **`statement_dump()`** — Return all statements in the local store.
- **`statement_statements(topics, dest)`** — Return filtered statements by topic and/or decryption key.

The SDK wraps these RPCs:

```ts
const sdk = createStatementSdk(client._request);
await sdk.submit(signedStatement);           // → statement_submit
await sdk.getStatements({ topics: [...] });  // → statement_statements
await sdk.dump();                            // → statement_dump
```

## SDK

The official TypeScript SDK is **`@polkadot-api/sdk-statement`** ([papi.how/sdks/statement](https://papi.how/sdks/statement)).

Key exports:

```ts
import { createStatementSdk, getStatementSigner, stringToTopic } from "@polkadot-api/sdk-statement";
```

- **`createStatementSdk(requestFn)`** — Creates the SDK from a polkadot-api client's `_request` method
- **`getStatementSigner(publicKey, type, signFn)`** — Creates a signer for sr25519/ed25519/ecdsa
- **`stringToTopic(str)`** — Converts a human-readable string to a 32-byte topic hash

## Decentralization Benefit

- **No single server dependency**: Any People Chain node gossips statements. If one node goes down, others continue.
- **Any relayer can pick up**: Multiple relayer daemons can poll the statement store. Whichever executes first wins (the contract prevents double-execution via nonces).
- **Censorship resistance**: Statements propagate via libp2p gossip — no centralized gatekeeper.

## Limitations

- **`--enable-statement-store` flag**: Nodes must explicitly opt in to the statement store. Not all chains or nodes have it enabled.
- **Balance requirement**: Submitting statements requires balance on People Chain for the allowance mechanism. Zero-balance accounts are rejected.
- **No built-in expiry**: Statements don't have a protocol-level TTL. Expiry is enforced at the application level (the `deadline` field in our meta-tx payload).
- **No subscription API in SDK**: The SDK provides `getStatements()` for polling but no WebSocket subscription. The relayer uses polling at 2-second intervals.
- **Statement size limits**: There are per-account and global size limits for statements. Large payloads may be rejected.

## References

- [`sc-statement-store`](https://github.com/nickalopolis/polkadot-sdk/tree/master/substrate/client/statement-store) — Client-side statement store implementation
- [`pallet-statement`](https://github.com/nickalopolis/polkadot-sdk/tree/master/substrate/frame/statement) — On-chain statement allowance pallet
- [`sc-network-statement`](https://github.com/nickalopolis/polkadot-sdk/tree/master/substrate/client/network/statement) — Network gossip layer for statements
- [Statement RPC definitions](https://github.com/nickalopolis/polkadot-sdk/tree/master/substrate/client/rpc-api/src/statement) — JSON-RPC interface
- [`@polkadot-api/sdk-statement`](https://papi.how/sdks/statement) — Official TypeScript SDK
- [Statement Store primitive](https://github.com/nickalopolis/polkadot-sdk/tree/master/substrate/primitives/statement-store) — Core types and traits
