/**
 * Live ONS Solana-originated claim e2e (spec/ONS.md 4.2), against devnet + Sepolia:
 *
 *  1. claim <label> on the ons-registration program (provisional PDA + claim VAA)
 *  2. deliver the claim VAA to OpaqueNameRegistry.registerFromVAA on Sepolia
 *  3. assert the registry holds the name under the surrogate registrant
 *
 * The registry's resulting mirror publication (its own sequence, printed at the
 * end) confirms the claim back on devnet after Sepolia finality (~19 min):
 *
 *   npx tsx scripts/relay-ons.ts mirror <sequence>
 *
 * then the provisional claim reconciles as confirmed. Run that second leg when
 * the guardians have signed; this script does not block on Ethereum finality.
 *
 *   npx tsx scripts/e2e-ons-claim.ts <label>
 */
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Contract, JsonRpcProvider, namehash } from "ethers";
import { keccak_256 } from "@noble/hashes/sha3";
import { createHash } from "node:crypto";
import { utils as coreUtils } from "@wormhole-foundation/sdk-solana-core";

import { ETH, SOL, sepoliaRpc } from "../src/config.js";
import { sendAndPoll, solCtx, solanaMessageFee } from "../src/solana.js";
import { deliverOnsClaim, onsRegistrationConfigPda } from "../src/ons.js";

const PARENT_NAME = "opqtest.eth";
// Canonical DKSAP test-vector keys (circuits/test/test_vectors.json).
const SPEND = Buffer.from(
  "0268680737c76dabb801cb2204f57dbe4e4579e4f710cd67dc1b4227592c81e9b5",
  "hex",
);
const VIEW = Buffer.from(
  "026a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb3",
  "hex",
);

const label = process.argv[2];
if (!label) {
  console.error("usage: e2e-ons-claim.ts <label>");
  process.exit(1);
}

const ixDisc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

const { connection, payer } = solCtx();
const programId = new PublicKey(SOL.onsRegistration);
const core = new PublicKey(SOL.wormholeCore);
const nameHash = Buffer.from(keccak_256(`${label}.${PARENT_NAME}`));

// 1. Provisional claim + Wormhole publish.
const emitter = coreUtils.deriveWormholeEmitterKey(SOL.onsRegistration);
const message = Keypair.generate();
const claimPda = PublicKey.findProgramAddressSync(
  [Buffer.from("ons_claim"), nameHash],
  programId,
)[0];

const fee = await solanaMessageFee();

const claimIx = new TransactionInstruction({
  programId,
  keys: [
    { pubkey: onsRegistrationConfigPda(), isSigner: false, isWritable: false },
    { pubkey: claimPda, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: emitter, isSigner: false, isWritable: false },
    { pubkey: coreUtils.deriveWormholeBridgeDataKey(core), isSigner: false, isWritable: true },
    { pubkey: coreUtils.deriveFeeCollectorKey(core), isSigner: false, isWritable: true },
    { pubkey: coreUtils.deriveEmitterSequenceKey(emitter, core), isSigner: false, isWritable: true },
    { pubkey: message.publicKey, isSigner: true, isWritable: true },
    { pubkey: core, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([
    ixDisc("claim"),
    nameHash,
    u32(label.length),
    Buffer.from(label, "utf8"),
    SPEND,
    VIEW,
    u32(0), // batch_id
    u64(fee), // wormhole_fee (10 lamports on devnet)
  ]),
});

console.log(`claiming ${label}.${PARENT_NAME} from devnet (provisional) ...`);
const sig = await sendAndPoll(connection, new Transaction().add(claimIx), [payer, message]);
console.log("  claim tx:", sig);

const tx = await connection.getTransaction(sig, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
});
const seqLog = tx?.meta?.logMessages?.map((l) => l.match(/Sequence: (\d+)/)).find(Boolean);
if (!seqLog) throw new Error("no Wormhole sequence in claim logs");
const sequence = BigInt(seqLog[1]!);
console.log("  claim VAA sequence:", sequence);

// 2. Deliver to Sepolia (waits for guardian signatures; Solana side is fast).
console.log("delivering claim to OpaqueNameRegistry on Sepolia ...");
const hash = await deliverOnsClaim(sequence);
console.log("  registerFromVAA tx:", hash);

// 3. Assert the canonical record.
const provider = new JsonRpcProvider(sepoliaRpc());
const registry = new Contract(
  ETH.onsRegistry,
  [
    "function text(bytes32 node, string key) view returns (string)",
    "function records(bytes32 node) view returns (address registrant, bytes32 solAuthority, bytes spendPubKey, bytes viewPubKey, uint64 updatedAt)",
    "event MirrorPublished(bytes32 indexed node, uint64 sequence, uint8 action)",
  ],
  provider,
);
const node = namehash(`${label}.${PARENT_NAME}`);
const rec = await registry.records(node);
const expectAuthority = "0x" + Buffer.from(payer.publicKey.toBytes()).toString("hex");
if (rec.solAuthority.toLowerCase() !== expectAuthority.toLowerCase()) {
  throw new Error(`solAuthority mismatch: ${rec.solAuthority} != ${expectAuthority}`);
}
console.log("  registrant (surrogate):", rec.registrant);
console.log("  text:", await registry.text(node, "com.opaque.meta"));

const receipt = await provider.getTransactionReceipt(hash);
for (const log of receipt!.logs) {
  try {
    const ev = registry.interface.parseLog(log);
    if (ev?.name === "MirrorPublished") {
      console.log(
        `confirmation mirror sequence: ${ev.args.sequence} — after Sepolia finality run:\n` +
          `  npx tsx scripts/relay-ons.ts mirror ${ev.args.sequence}`,
      );
    }
  } catch {
    /* other contract's log */
  }
}
console.log("claim leg complete (canonical-chain-wins: name now authoritative on Ethereum)");
