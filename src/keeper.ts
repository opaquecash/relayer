/**
 * VAA-delivery keeper (spec/relayer-market.md §4.4, plan 5.6): the liveness half of the
 * Solana<->Ethereum bridge. Wormhole's automatic relayer is EVM-only, so without this loop
 * every Solana-originated message (ONS claims, UAB announcements) sits guardian-signed but
 * undelivered forever, and Ethereum-originated mirrors never reach the Solana programs.
 *
 * Four duties, each idempotent via on-chain consumption state (no local database):
 *   - ONS claim    Solana -> Sepolia   OpaqueNameRegistry.registerFromVAA   consumed(key)
 *   - ONS mirror   Sepolia -> Solana   ons-mirror.receive_record            processed PDA
 *   - UAB announce Solana -> Sepolia   UABReceiver.receiveAnnouncement      consumed(key)
 *   - UAB announce Sepolia -> Solana   uab-receiver.receive_announcement    processed PDA
 *
 * Guardian signatures make forgery impossible; this only moves signed bytes, so running it
 * requires no trust beyond gas/rent keys.
 */
import { PublicKey } from "@solana/web3.js";
import { Contract, JsonRpcProvider, solidityPackedKeccak256 } from "ethers";
import { utils as coreUtils } from "@wormhole-foundation/sdk-solana-core";

import { ETH, SOL, WORMHOLESCAN, sepoliaRpc } from "./config.js";
import { deliverOnsClaim, deliverOnsMirror, onsEthereumEmitterHex, onsSolanaEmitterHex } from "./ons.js";
import { ethEmitterHex, receiveAnnouncementOnEth } from "./evm.js";
import {
  postVaaToSolana,
  receiveAnnouncementOnSolana,
  solCtx,
  solanaEmitterHex,
} from "./solana.js";
import { parseVaa } from "./wormhole.js";

export interface SignedVaa {
  sequence: bigint;
  bytes: Uint8Array;
}

/** List guardian-signed VAAs for one emitter (most recent first, max `pageSize`). */
export async function listSignedVaas(
  chain: number,
  emitterHex: string,
  pageSize = 50,
): Promise<SignedVaa[]> {
  const url = `${WORMHOLESCAN}/api/v1/vaas/${chain}/${emitterHex}?pageSize=${pageSize}`;
  const res = await fetch(url);
  if (res.status === 404) return []; // emitter has published nothing yet
  if (!res.ok) throw new Error(`wormholescan ${res.status}: ${url}`);
  const body = (await res.json()) as {
    data?: { sequence: number | string; vaa?: string | null }[];
  };
  return (body.data ?? [])
    .filter((v) => v.vaa)
    .map((v) => ({
      sequence: BigInt(v.sequence),
      bytes: new Uint8Array(Buffer.from(v.vaa as string, "base64")),
    }));
}

/** The replay key both Sepolia receivers store: keccak256(emitterChain ‖ emitterAddr ‖ sequence). */
function consumedKey(emitterChain: number, emitterHex: string, sequence: bigint): string {
  return solidityPackedKeccak256(
    ["uint16", "bytes32", "uint64"],
    [emitterChain, `0x${emitterHex}`, sequence],
  );
}

async function evmConsumed(
  contractAddress: string,
  emitterChain: number,
  emitterHex: string,
  sequence: bigint,
): Promise<boolean> {
  const provider = new JsonRpcProvider(sepoliaRpc());
  const c = new Contract(
    contractAddress,
    ["function consumed(bytes32) view returns (bool)"],
    provider,
  );
  return (await c.consumed(consumedKey(emitterChain, emitterHex, sequence))) as boolean;
}

/** Whether a Solana receiver program already created its `processed` PDA for this VAA. */
async function solanaProcessed(programId: string, vaaBytes: Uint8Array): Promise<boolean> {
  const { connection } = solCtx();
  const posted = coreUtils.derivePostedVaaKey(
    new PublicKey(SOL.wormholeCore),
    Buffer.from(parseVaa(vaaBytes).hash),
  );
  const processed = PublicKey.findProgramAddressSync(
    [Buffer.from("processed"), posted.toBuffer()],
    new PublicKey(programId),
  )[0];
  return (await connection.getAccountInfo(processed)) != null;
}

interface Duty {
  name: string;
  emitterChain: number;
  emitterHex: () => string;
  isDelivered: (vaa: SignedVaa) => Promise<boolean>;
  deliver: (vaa: SignedVaa) => Promise<string>;
}

const DUTIES: Duty[] = [
  {
    name: "ons-claim sol->eth",
    emitterChain: SOL.whChain,
    emitterHex: onsSolanaEmitterHex,
    isDelivered: (v) =>
      evmConsumed(ETH.onsRegistry, SOL.whChain, onsSolanaEmitterHex(), v.sequence),
    deliver: (v) => deliverOnsClaim(v.sequence),
  },
  {
    name: "ons-mirror eth->sol",
    emitterChain: ETH.whChain,
    emitterHex: onsEthereumEmitterHex,
    isDelivered: (v) => solanaProcessed(SOL.onsMirror, v.bytes),
    deliver: async (v) => (await deliverOnsMirror(v.sequence)).signature,
  },
  {
    name: "uab sol->eth",
    emitterChain: SOL.whChain,
    emitterHex: solanaEmitterHex,
    isDelivered: (v) =>
      evmConsumed(ETH.uabReceiver, SOL.whChain, solanaEmitterHex(), v.sequence),
    deliver: (v) => receiveAnnouncementOnEth(v.bytes),
  },
  {
    name: "uab eth->sol",
    emitterChain: ETH.whChain,
    emitterHex: ethEmitterHex,
    isDelivered: (v) => solanaProcessed(SOL.uabReceiver, v.bytes),
    deliver: async (v) => receiveAnnouncementOnSolana(await postVaaToSolana(v.bytes)),
  },
];

/** Sequences that keep failing this process lifetime: duty -> sequence -> attempts. */
const failures = new Map<string, Map<bigint, number>>();
const MAX_ATTEMPTS = 3;

export interface KeeperTickResult {
  delivered: number;
  skipped: number;
  failed: number;
}

/** One pass over all duties: deliver every signed-but-unconsumed VAA. */
export async function runKeeperTick(
  log: (msg: string) => void = console.log,
): Promise<KeeperTickResult> {
  const result: KeeperTickResult = { delivered: 0, skipped: 0, failed: 0 };
  for (const duty of DUTIES) {
    let vaas: SignedVaa[];
    try {
      vaas = await listSignedVaas(duty.emitterChain, duty.emitterHex());
    } catch (e) {
      log(`[keeper] ${duty.name}: wormholescan list failed: ${(e as Error).message}`);
      continue;
    }
    // Oldest first so sequence-ordered programs (ons-mirror staleness check) accept them.
    vaas.sort((a, b) => (a.sequence < b.sequence ? -1 : 1));
    const dutyFailures = failures.get(duty.name) ?? new Map<bigint, number>();
    failures.set(duty.name, dutyFailures);
    for (const vaa of vaas) {
      if ((dutyFailures.get(vaa.sequence) ?? 0) >= MAX_ATTEMPTS) {
        result.skipped++;
        continue;
      }
      try {
        if (await duty.isDelivered(vaa)) continue;
        const tx = await duty.deliver(vaa);
        result.delivered++;
        log(`[keeper] ${duty.name} seq ${vaa.sequence} delivered: ${tx}`);
      } catch (e) {
        const attempts = (dutyFailures.get(vaa.sequence) ?? 0) + 1;
        dutyFailures.set(vaa.sequence, attempts);
        result.failed++;
        log(
          `[keeper] ${duty.name} seq ${vaa.sequence} failed (attempt ${attempts}/${MAX_ATTEMPTS}): ${(e as Error).message}`,
        );
      }
    }
  }
  return result;
}
