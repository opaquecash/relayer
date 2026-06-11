/**
 * One-off ONS wiring (run after deploying the ons programs and the registry):
 *  1. ons-mirror config <- canonical registry emitter (Sepolia OpaqueNameRegistry)
 *  2. ons-registration config <- parent name + mirror program id
 *  3. OpaqueNameRegistry.setExpectedEmitter <- the registration program's emitter PDA
 *
 *   npx tsx scripts/setup-ons.ts [parentName]   (default "opqtest.eth")
 */
import { Contract, JsonRpcProvider, Wallet } from "ethers";

import { ETH, WH_CHAIN, sepoliaKey, sepoliaRpc } from "../src/config.js";
import {
  initOrSetOnsMirrorConfig,
  initOrSetOnsRegistrationConfig,
  onsEthereumEmitterHex,
  onsSolanaEmitterHex,
} from "../src/ons.js";

const parentName = process.argv[2] ?? "opqtest.eth";

console.log(`ons-mirror config <- (chain ${ETH.whChain}, emitter ${onsEthereumEmitterHex()})`);
console.log("  tx:", await initOrSetOnsMirrorConfig());

console.log(`ons-registration config <- ("${parentName}", mirror program)`);
console.log("  tx:", await initOrSetOnsRegistrationConfig(parentName));

const solEmitter = `0x${onsSolanaEmitterHex()}`;
console.log(`OpaqueNameRegistry.setExpectedEmitter(${WH_CHAIN.solana}, ${solEmitter})`);
const wallet = new Wallet(sepoliaKey(), new JsonRpcProvider(sepoliaRpc()));
const registry = new Contract(
  ETH.onsRegistry,
  ["function setExpectedEmitter(uint16 chainId, bytes32 emitter)"],
  wallet,
);
const tx = await registry.setExpectedEmitter(WH_CHAIN.solana, solEmitter);
console.log("  tx:", (await tx.wait()).hash);
console.log("done");
