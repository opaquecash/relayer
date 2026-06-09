import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { Keypair } from "@solana/web3.js";

const require = createRequire(import.meta.url);
const root = resolve(fileURLToPath(import.meta.url), "..", "..");

/** Wormhole chain ids. */
export const WH_CHAIN = { ethereum: 2, solana: 1 } as const;

/** Ethereum Sepolia deployment. */
export const ETH = {
  wormholeCore: "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78",
  uabSender: "0x872787c0BD1A0C71e6D1be5a144EB044e0CB2069",
  uabReceiver: "0x9eF189f7a263F870Cf80f9A89d1349A6AF7b15cF",
  whChain: WH_CHAIN.ethereum,
} as const;

/** Solana devnet deployment. */
export const SOL = {
  wormholeCore: "3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5",
  stealthAnnouncer: "HGFn2fH7bVQ5cSuiG52NjzN9m11YrB3FZUfoN9b9A5jf",
  uabReceiver: "7d4Sbmmpy954JwSNdjwf31pgbeWUQqwpgNdte5iy3vuM",
  whChain: WH_CHAIN.solana,
} as const;

/** Wormholescan Testnet API (signed VAA retrieval). */
export const WORMHOLESCAN = "https://api.testnet.wormholescan.io";

export const IDL = {
  uabReceiver: require("../idl/uab_receiver.json"),
  stealthAnnouncer: require("../idl/stealth_announcer.json"),
};

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Set ${name} in relayer/.env`);
  return v;
}

export function sepoliaRpc(): string {
  return env("SEPOLIA_RPC_URL");
}

export function sepoliaKey(): string {
  return env("SEPOLIA_PRIVATE_KEY");
}

export function solanaRpc(): string {
  return process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
}

export function solanaKeypair(): Keypair {
  const p = (process.env.SOLANA_KEYPAIR || "~/.config/solana/id.json").replace(/^~/, homedir());
  const secret = JSON.parse(readFileSync(p, "utf-8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
