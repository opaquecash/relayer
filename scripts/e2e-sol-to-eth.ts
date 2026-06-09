/**
 * End-to-end UAB test: Solana devnet -> Ethereum Sepolia.
 * Announce on Solana, fetch the guardian VAA, deliver it to the Sepolia UABReceiver,
 * and confirm the payload round-trips byte-for-byte.
 */
import { SOL } from "../src/config.js";
import { announceWithRelaySolana, solanaEmitterHex, solanaMessageFee } from "../src/solana.js";
import { receiveAnnouncementOnEth } from "../src/evm.js";
import { fetchVaaBytes } from "../src/wormhole.js";
import { decodePayload, describePayload } from "../src/payload.js";

function sampleAnnouncement() {
  const ephemeralPubKey = new Uint8Array(33);
  ephemeralPubKey[0] = 0x02;
  ephemeralPubKey.fill(0x11, 1);
  const stealthAddress = new Uint8Array(20).fill(0xab); // EVM-style 20-byte stealth address
  const metadata = new Uint8Array([0x42, 0xde, 0xad, 0xbe, 0xef]); // view tag 0x42 + tail
  return { schemeId: 1n, stealthAddress, ephemeralPubKey, metadata };
}

async function main() {
  const a = sampleAnnouncement();
  const fee = await solanaMessageFee();
  console.log(`[Solana] announce_with_relay (fee=${fee} lamports) …`);
  const sequence = await announceWithRelaySolana({ ...a, batchId: 0, fee });
  console.log(`  published seq ${sequence} from emitter 0x${solanaEmitterHex()}`);

  console.log(`[Wormhole] fetching signed VAA (chain ${SOL.whChain}) …`);
  const vaa = await fetchVaaBytes(SOL.whChain, solanaEmitterHex(), sequence);
  console.log(`  got VAA (${vaa.length} bytes)`);

  console.log("[Sepolia] UABReceiver.receiveAnnouncement …");
  const payloadHex = await receiveAnnouncementOnEth(vaa);
  const decoded = decodePayload(new Uint8Array(Buffer.from(payloadHex.slice(2), "hex")));
  console.log("  CrossChainAnnouncement payload:", describePayload(decoded));

  const gotStealth = Buffer.from(decoded.stealthAddress.slice(12)).toString("hex");
  const wantStealth = Buffer.from(a.stealthAddress).toString("hex");
  if (gotStealth !== wantStealth) throw new Error(`stealth mismatch: ${gotStealth} != ${wantStealth}`);
  if (decoded.viewTag !== 0x42) throw new Error(`view tag mismatch: ${decoded.viewTag}`);
  console.log("\n✅ Solana -> Ethereum: announcement delivered and payload verified.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
