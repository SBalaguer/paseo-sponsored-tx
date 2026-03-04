import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";

const PEOPLE_WS = "wss://previewnet.substrate.dev/people";

async function main() {
  const client = createClient(getWsProvider(PEOPLE_WS));
  const req = client._request;
  
  const metaHex = await req("state_getMetadata", []) as string;
  const metaBytes = Buffer.from(metaHex.slice(2), 'hex');
  const metaStr = metaBytes.toString('utf8', 0, metaBytes.length);
  
  // Find set_stmt_store with more context to determine the pallet
  console.log("=== Context around set_stmt_store ===");
  let idx = 0;
  while ((idx = metaStr.indexOf("set_stmt_store", idx)) !== -1) {
    const start = Math.max(0, idx - 400);
    const end = Math.min(metaStr.length, idx + 500);
    const context = metaStr.slice(start, end).replace(/[^\x20-\x7e]/g, '.');
    console.log(context);
    console.log("\n===\n");
    idx++;
  }

  // Also search for which pallet contains StmtStoreAssociatedAccount
  console.log("=== StmtStoreAssociatedAccount pallet ===");
  idx = 0;
  while ((idx = metaStr.indexOf("StmtStoreAssociatedAccount", idx)) !== -1) {
    const start = Math.max(0, idx - 500);
    const end = Math.min(metaStr.length, idx + 200);
    const context = metaStr.slice(start, end).replace(/[^\x20-\x7e]/g, '.');
    console.log(context);
    console.log("\n===\n");
    idx++;
  }

  client.destroy();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
