# Sponsored NFT Ticket Minting on Passet Hub

Mint free NFT event tickets on Polkadot's Passet Hub testnet (chain ID `420420422`) without holding native PAS tokens. A backend relay server pays gas on behalf of users using **EIP-2771 meta-transactions**.

## Architecture

```
User (MetaMask)                Server (Express)              Blockchain (Passet Hub)
    |                               |                               |
    |-- 1. Sign EIP-712 request --->|                               |
    |   (MetaMask popup)            |                               |
    |                               |-- 2. Anti-spam checks         |
    |                               |   (rate limit, dedup)         |
    |                               |                               |
    |                               |-- 3. forwarder.execute(req) ->|
    |                               |   (server pays gas)           |
    |                               |                               |-- 4. Verify EIP-712 sig
    |                               |                               |-- 5. Forward to TicketNFT
    |                               |                               |-- 6. _msgSender() = user
    |                               |<--- tx receipt ---------------|
    |<--- tx hash + success --------|                               |
```

**Contracts (2 total):**
- `ERC2771Forwarder` — OpenZeppelin v5, deployed as-is. Verifies EIP-712 signatures, manages nonces, forwards calls.
- `TicketNFT` — Custom ERC-721 with `ERC2771Context`. Soulbound, 1 mint per address, supply cap, deadline.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your deployer private key
# Fund from faucet: https://faucet.polkadot.io/?parachain=1111
```

### 3. Compile & test

```bash
npm run compile
npm test
```

### 4. Deploy to Passet Hub testnet

```bash
npm run deploy
# Copy the output addresses into .env (FORWARDER_ADDRESS, TICKET_NFT_ADDRESS)
```

### 5. Integration test on testnet

```bash
npm run test:mint
```

### 6. Start relay server

```bash
npm run server
```

### 7. Open frontend

Open `frontend/index.html` in a browser (or serve it).

## Project Structure

| File | Purpose |
|------|---------|
| `contracts/TicketNFT.sol` | NFT contract with ERC2771Context |
| `contracts/ForwarderImport.sol` | Forces Hardhat to compile the OZ forwarder |
| `scripts/deploy.ts` | Deploy Forwarder + NFT to Passet Hub |
| `scripts/test-mint.ts` | End-to-end integration test on testnet |
| `server/index.ts` | Express relay server with anti-spam |
| `frontend/index.html` | Single-page mint UI |
| `test/TicketNFT.test.ts` | Unit tests (13 tests) |

## Anti-Spam Layers

| Layer | Mechanism | Where |
|-------|-----------|-------|
| 1 | IP rate limiting (3/day) | Server |
| 2 | Wallet dedup (1 per wallet) | Server |
| 3 | Target contract whitelist | Server |
| 4 | EIP-712 signature verification | Forwarder (on-chain) |
| 5 | hasMinted (1 per address) | TicketNFT (on-chain) |
| 6 | maxSupply cap | TicketNFT (on-chain) |
| 7 | mintDeadline | TicketNFT (on-chain) |
| 8 | Soulbound (non-transferable) | TicketNFT (on-chain) |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check + relayer balance |
| `GET` | `/stats` | Total relayed, minted, balance |
| `GET` | `/api/config` | Contract addresses for frontend |
| `GET` | `/api/nonce/:address` | User's current forwarder nonce |
| `POST` | `/api/relay` | Submit signed ForwardRequest for relay |

## Network

- **Chain:** Passet Hub Testnet
- **Chain ID:** `420420422`
- **RPC:** `https://testnet-passet-hub-eth-rpc.polkadot.io`
- **Explorer:** `https://blockscout-passet-hub.parity-testnet.parity.io`
- **Faucet:** `https://faucet.polkadot.io/?parachain=1111`
