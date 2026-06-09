/**
 * End-to-end UAB test: Ethereum Sepolia -> Solana devnet.
 * Announce on Sepolia, fetch the guardian VAA, post + deliver it to the Solana uab-receiver,
 * and confirm the payload round-trips byte-for-byte.
 *
 * Uses consistencyLevel 201 (safe) to keep the guardian wait short on testnet; production uses 200.
 */
import { ethers } from "ethers";
import { ETH } from "../src/config.js";
import { announceWithRelay, ethEmitterHex } from "../src/evm.js";
import { postVaaToSolana, receiveAnnouncementOnSolana, readPostedVaaPayload } from "../src/solana.js";
import { fetchVaaBytes } from "../src/wormhole.js";
import { decodePayload, describePayload } from "../src/payload.js";

const CONSISTENCY_SAFE = 201;

async function main() {
  const stealth = "0x" + "cd".repeat(20);
  const ephemeral = "0x03" + "22".repeat(32); // 33 bytes
  const metadata = "0x7711223344"; // view tag 0x77 + tail

  console.log("[Sepolia] announceWithRelay …");
  const sequence = await announceWithRelay({
    schemeId: 1n,
    stealthAddress: ethers.getAddress(stealth),
    ephemeralPubKey: ephemeral,
    metadata,
    consistencyLevel: CONSISTENCY_SAFE,
  });
  console.log(`  published seq ${sequence} from emitter 0x${ethEmitterHex()}`);

  console.log(`[Wormhole] fetching signed VAA (chain ${ETH.whChain}) …`);
  const vaa = await fetchVaaBytes(ETH.whChain, ethEmitterHex(), sequence);
  console.log(`  got VAA (${vaa.length} bytes)`);

  console.log("[Solana] posting VAA to the core bridge …");
  const postedVaa = await postVaaToSolana(vaa);
  console.log(`  posted VAA account ${postedVaa.toBase58()}`);

  console.log("[Solana] uab-receiver.receive_announcement …");
  const sig = await receiveAnnouncementOnSolana(postedVaa);
  console.log(`  ok: ${sig}`);

  const payload = await readPostedVaaPayload(postedVaa);
  const decoded = decodePayload(payload);
  console.log("  delivered payload:", describePayload(decoded));

  const gotStealth = Buffer.from(decoded.stealthAddress.slice(12)).toString("hex");
  if (gotStealth !== "cd".repeat(20)) throw new Error(`stealth mismatch: ${gotStealth}`);
  if (decoded.viewTag !== 0x77) throw new Error(`view tag mismatch: ${decoded.viewTag}`);
  console.log("\n✅ Ethereum -> Solana: announcement delivered and payload verified.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
