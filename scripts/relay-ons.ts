/**
 * Deliver one ONS message (liveness-only role; spec/ONS.md 5):
 *
 *   npx tsx scripts/relay-ons.ts mirror <sequence>   # Ethereum registry -> ons-mirror
 *   npx tsx scripts/relay-ons.ts claim <sequence>    # ons-registration -> registry
 */
import { deliverOnsClaim, deliverOnsMirror } from "../src/ons.js";

const [kind, seq] = process.argv.slice(2);
if ((kind !== "mirror" && kind !== "claim") || seq === undefined) {
  console.error("usage: relay-ons.ts <mirror|claim> <sequence>");
  process.exit(1);
}

if (kind === "mirror") {
  const { record, signature } = await deliverOnsMirror(BigInt(seq));
  console.log(`mirror record ${record.toBase58()} updated in ${signature}`);
} else {
  const hash = await deliverOnsClaim(BigInt(seq));
  console.log(`claim applied on Sepolia in ${hash}`);
}
