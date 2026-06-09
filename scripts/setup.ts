/**
 * Cross-register the UAB emitters so each receiver trusts the other chain's sender.
 *   - Solana uab-receiver  -> trusts (chain 2, padded Sepolia UABSender)
 *   - Sepolia UABReceiver   -> trusts (chain 1, Solana emitter PDA)
 * Idempotent: re-running just updates the trusted emitter.
 */
import { ethers } from "ethers";
import { ETH, SOL, WH_CHAIN } from "../src/config.js";
import { evmCtx, ethEmitterHex } from "../src/evm.js";
import { initOrSetConfig, solanaEmitter, solanaEmitterHex } from "../src/solana.js";

async function main() {
  const ethEmitter32 = ethers.getBytes(ethers.zeroPadValue(ETH.uabSender, 32));
  const solEmitter = solanaEmitter();

  console.log("Emitters:");
  console.log(`  Ethereum (chain ${ETH.whChain}): UABSender ${ETH.uabSender}`);
  console.log(`    -> Wormhole emitter 0x${ethEmitterHex()}`);
  console.log(`  Solana   (chain ${SOL.whChain}): emitter PDA ${solEmitter.toBase58()}`);
  console.log(`    -> Wormhole emitter 0x${solanaEmitterHex()}`);

  console.log("\n[Solana] uab-receiver: trust Ethereum UABSender …");
  const solSig = await initOrSetConfig(WH_CHAIN.ethereum, ethEmitter32);
  console.log(`  ok: ${solSig}`);

  console.log("\n[Sepolia] UABReceiver.setExpectedEmitter(1, solanaEmitter) …");
  const { receiver } = evmCtx();
  const tx = await receiver.setExpectedEmitter(WH_CHAIN.solana, "0x" + solanaEmitterHex());
  await tx.wait();
  console.log(`  ok: ${tx.hash}`);
  console.log(`  on-chain expectedEmitter = ${await receiver.expectedEmitter()}`);

  console.log("\nSetup complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
