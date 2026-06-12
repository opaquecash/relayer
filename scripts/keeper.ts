/**
 * Run the VAA-delivery keeper (spec/relayer-market.md §4.4): auto-relays ONS claims,
 * ONS mirrors, and UAB announcements in both directions until stopped.
 *
 *   npx tsx scripts/keeper.ts            # loop forever (default every 30s)
 *   npx tsx scripts/keeper.ts --once     # single pass, then exit
 *   KEEPER_INTERVAL_MS=60000 npx tsx scripts/keeper.ts
 *
 * Needs relayer/.env: SEPOLIA_RPC_URL + SEPOLIA_PRIVATE_KEY (gas) and the Solana
 * keypair (rent/fees); see .env.example.
 */
import { runKeeperTick } from "../src/keeper.js";

const once = process.argv.includes("--once");
const intervalMs = Number(process.env.KEEPER_INTERVAL_MS ?? 30_000);

const ts = () => new Date().toISOString();

for (;;) {
  try {
    const { delivered, skipped, failed } = await runKeeperTick((m) => console.log(`${ts()} ${m}`));
    if (delivered || failed) {
      console.log(`${ts()} [keeper] tick: ${delivered} delivered, ${failed} failed, ${skipped} skipped`);
    }
  } catch (e) {
    console.error(`${ts()} [keeper] tick crashed: ${(e as Error).message}`);
  }
  if (once) break;
  await new Promise((r) => setTimeout(r, intervalMs));
}
