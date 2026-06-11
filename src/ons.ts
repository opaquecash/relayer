/**
 * ONS delivery (spec/ONS.md): carries the registry's mirror payloads to the Solana
 * ons-mirror program (Ethereum -> Solana) and Solana-originated claim payloads to
 * OpaqueNameRegistry.registerFromVAA (Solana -> Ethereum). Same liveness-only role
 * as the UAB relay: guardian signatures make forgery impossible; this just moves
 * signed bytes.
 *
 * Raw instructions (no IDL): the ons programs are anchor 0.32 but the calls here
 * are two fixed shapes.
 */
import { createHash } from "node:crypto";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Contract, JsonRpcProvider, Wallet, zeroPadValue } from "ethers";
import { utils as coreUtils } from "@wormhole-foundation/sdk-solana-core";

import { ETH, SOL, sepoliaKey, sepoliaRpc } from "./config.js";
import { fetchVaaBytes } from "./wormhole.js";
import { postVaaToSolana, sendAndPoll, solCtx } from "./solana.js";

const ONS_MIRROR = new PublicKey(SOL.onsMirror);
const ONS_REGISTRATION = new PublicKey(SOL.onsRegistration);

const ixDisc = (name: string): Buffer =>
  createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);

/** The ONS Ethereum emitter: the registry address left-padded to 32 bytes (hex, no 0x). */
export function onsEthereumEmitterHex(): string {
  return zeroPadValue(ETH.onsRegistry, 32).slice(2);
}

/** The ONS Solana emitter: the registration program's emitter PDA (hex, no 0x). */
export function onsSolanaEmitterHex(): string {
  const emitter = coreUtils.deriveWormholeEmitterKey(SOL.onsRegistration);
  return Buffer.from(emitter.toBytes()).toString("hex");
}

export function onsMirrorConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], ONS_MIRROR)[0];
}

export function onsRegistrationConfigPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], ONS_REGISTRATION)[0];
}

export function onsRecordPda(nameHash: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("ons_mirror"), Buffer.from(nameHash)],
    ONS_MIRROR,
  )[0];
}

/**
 * Deliver one ONS mirror payload to devnet: fetch the signed VAA for the registry
 * emitter at `sequence`, post it to the core bridge, and call receive_record. The
 * name_hash is read out of the signed payload (offset 2, 32 bytes).
 */
export async function deliverOnsMirror(sequence: bigint): Promise<{
  record: PublicKey;
  signature: string;
}> {
  const vaaBytes = await fetchVaaBytes(ETH.whChain, onsEthereumEmitterHex(), sequence);
  const postedVaaKey = await postVaaToSolana(vaaBytes);

  const { connection, payer } = solCtx();
  const info = await connection.getAccountInfo(postedVaaKey);
  if (!info) throw new Error("posted VAA account missing");
  const payloadLen = info.data.readUInt32LE(91);
  const payload = info.data.subarray(95, 95 + payloadLen);
  if (payloadLen !== 164 || payload[0] !== 1) {
    throw new Error(`not an ONS mirror payload (len=${payloadLen}, version=${payload[0]})`);
  }
  const nameHash = payload.subarray(2, 34);

  const record = onsRecordPda(nameHash);
  const processed = PublicKey.findProgramAddressSync(
    [Buffer.from("processed"), postedVaaKey.toBuffer()],
    ONS_MIRROR,
  )[0];

  const ix = new TransactionInstruction({
    programId: ONS_MIRROR,
    keys: [
      { pubkey: onsMirrorConfigPda(), isSigner: false, isWritable: false },
      { pubkey: postedVaaKey, isSigner: false, isWritable: false },
      { pubkey: record, isSigner: false, isWritable: true },
      { pubkey: processed, isSigner: false, isWritable: true },
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ixDisc("receive_record"), Buffer.from(nameHash)]),
  });
  const signature = await sendAndPoll(connection, new Transaction().add(ix), [payer]);
  return { record, signature };
}

/**
 * Deliver one ONS claim to Sepolia: fetch the signed VAA for the registration
 * program emitter at `sequence` and submit it to OpaqueNameRegistry.registerFromVAA.
 */
export async function deliverOnsClaim(sequence: bigint): Promise<string> {
  const vaaBytes = await fetchVaaBytes(SOL.whChain, onsSolanaEmitterHex(), sequence);
  const provider = new JsonRpcProvider(sepoliaRpc());
  const wallet = new Wallet(sepoliaKey(), provider);
  const registry = new Contract(
    ETH.onsRegistry,
    ["function registerFromVAA(bytes encodedVaa) payable"],
    wallet,
  );
  const tx = await registry.registerFromVAA(vaaBytes, { gasLimit: 600_000n });
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`registerFromVAA reverted: ${receipt.hash}`);
  return receipt.hash;
}

/** Create (or update) the ons-mirror config pinning the canonical registry emitter. */
export async function initOrSetOnsMirrorConfig(): Promise<string> {
  const { connection, payer } = solCtx();
  const config = onsMirrorConfigPda();
  const emitter = Buffer.from(onsEthereumEmitterHex(), "hex");
  const exists = await connection.getAccountInfo(config);

  const data = exists
    ? Buffer.concat([ixDisc("set_source_emitter"), u16(ETH.whChain), emitter])
    : Buffer.concat([ixDisc("initialize"), u16(ETH.whChain), emitter]);
  const keys = exists
    ? [
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ]
    : [
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
  const ix = new TransactionInstruction({ programId: ONS_MIRROR, keys, data });
  return sendAndPoll(connection, new Transaction().add(ix), [payer]);
}

/** Create (or update) the ons-registration config (parent name + mirror program). */
export async function initOrSetOnsRegistrationConfig(parentName: string): Promise<string> {
  const { connection, payer } = solCtx();
  const config = onsRegistrationConfigPda();
  const exists = await connection.getAccountInfo(config);

  const name = Buffer.from(parentName, "utf8");
  const nameArg = Buffer.concat([u32(name.length), name]);
  const data = Buffer.concat([
    ixDisc(exists ? "set_config" : "initialize"),
    nameArg,
    ONS_MIRROR.toBuffer(),
  ]);
  const keys = exists
    ? [
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: false },
      ]
    : [
        { pubkey: config, isSigner: false, isWritable: true },
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ];
  const ix = new TransactionInstruction({ programId: ONS_REGISTRATION, keys, data });
  return sendAndPoll(connection, new Transaction().add(ix), [payer]);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
