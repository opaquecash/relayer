import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, Wallet, BN } = anchorPkg;
import { utils as coreUtils } from "@wormhole-foundation/sdk-solana-core";
import { parseVaa } from "./wormhole.js";
import { IDL, SOL, solanaKeypair, solanaRpc } from "./config.js";

export function solCtx() {
  const connection = new Connection(solanaRpc(), "confirmed");
  const payer = solanaKeypair();
  const wallet = new Wallet(payer);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const uabReceiver = new Program(IDL.uabReceiver as any, provider);
  const stealthAnnouncer = new Program(IDL.stealthAnnouncer as any, provider);
  return { connection, payer, wallet, provider, uabReceiver, stealthAnnouncer };
}

/**
 * Send a transaction and confirm by polling getSignatureStatuses over HTTP.
 * sendAndConfirmTransaction needs a websocket signatureSubscribe, which several
 * RPC providers (e.g. Alchemy devnet) do not offer.
 */
export async function sendAndPoll(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  timeoutMs = 90_000,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = (await connection.getSignatureStatuses([signature])).value[0];
    if (st?.err) throw new Error(`transaction failed: ${JSON.stringify(st.err)} (${signature})`);
    if (
      st?.confirmationStatus === "confirmed" ||
      st?.confirmationStatus === "finalized"
    ) {
      return signature;
    }
    if (Date.now() > deadline) throw new Error(`confirmation timeout: ${signature}`);
    await new Promise((r) => setTimeout(r, 1_500));
  }
}

/** The 32-byte Wormhole emitter (the stealth-announcer's emitter PDA). */
export function solanaEmitter(): PublicKey {
  return coreUtils.deriveWormholeEmitterKey(SOL.stealthAnnouncer);
}

export function solanaEmitterHex(): string {
  return Buffer.from(solanaEmitter().toBytes()).toString("hex");
}

function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], new PublicKey(SOL.uabReceiver))[0];
}

/** Current Wormhole message fee on Solana (lamports). */
export async function solanaMessageFee(): Promise<bigint> {
  const { connection } = solCtx();
  const bridge = await coreUtils.getWormholeBridgeData(connection, new PublicKey(SOL.wormholeCore));
  return BigInt((bridge as any).config.fee.toString());
}

/** Create the uab-receiver config (or update the trusted source emitter if it exists). */
export async function initOrSetConfig(sourceChain: number, sourceEmitter: Uint8Array): Promise<string> {
  const { uabReceiver, payer, connection } = solCtx();
  const config = configPda();
  const exists = await connection.getAccountInfo(config);
  const emitter = Array.from(sourceEmitter);
  if (!exists) {
    return uabReceiver.methods
      .initialize(sourceChain, emitter)
      .accountsPartial({ config, admin: payer.publicKey, systemProgram: SystemProgram.programId })
      .rpc();
  }
  return uabReceiver.methods
    .setSourceEmitter(sourceChain, emitter)
    .accountsPartial({ config, admin: payer.publicKey })
    .rpc();
}

/** Announce on Solana and relay via Wormhole; returns the emitter sequence. */
export async function announceWithRelaySolana(args: {
  schemeId: bigint;
  stealthAddress: Uint8Array;
  ephemeralPubKey: Uint8Array;
  metadata: Uint8Array;
  batchId: number;
  fee: bigint;
}): Promise<bigint> {
  const { stealthAnnouncer, connection, payer } = solCtx();
  const core = new PublicKey(SOL.wormholeCore);
  const emitter = solanaEmitter();
  const message = Keypair.generate();

  const sig = await stealthAnnouncer.methods
    .announceWithRelay(
      new BN(args.schemeId.toString()),
      Buffer.from(args.stealthAddress),
      Buffer.from(args.ephemeralPubKey),
      Buffer.from(args.metadata),
      args.batchId,
      new BN(args.fee.toString()),
    )
    .accountsPartial({
      caller: payer.publicKey,
      wormholeEmitter: emitter,
      wormholeConfig: coreUtils.deriveWormholeBridgeDataKey(core),
      wormholeFeeCollector: coreUtils.deriveFeeCollectorKey(core),
      wormholeSequence: coreUtils.deriveEmitterSequenceKey(emitter, core),
      wormholeMessage: message.publicKey,
      wormholeProgram: core,
      clock: SYSVAR_CLOCK_PUBKEY,
      rent: SYSVAR_RENT_PUBKEY,
      systemProgram: SystemProgram.programId,
    })
    .signers([message])
    .rpc();

  const tx = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs = tx?.meta?.logMessages ?? [];
  const m = logs.map((l) => l.match(/Sequence: (\d+)/)).find(Boolean);
  if (!m) throw new Error("Wormhole sequence not found in logs:\n" + logs.join("\n"));
  return BigInt(m[1]);
}

/** Verify + post a VAA to the Solana core bridge; returns the PostedVAA account key. */
export async function postVaaToSolana(vaaBytes: Uint8Array): Promise<PublicKey> {
  const { connection, payer } = solCtx();
  const core = new PublicKey(SOL.wormholeCore);
  const vaa = parseVaa(vaaBytes);
  const postedVaaKey = coreUtils.derivePostedVaaKey(core, Buffer.from(vaa.hash));
  if (await connection.getAccountInfo(postedVaaKey)) return postedVaaKey;

  const signatureSet = Keypair.generate();
  const verifyIxs = await coreUtils.createVerifySignaturesInstructions(
    connection,
    core,
    payer.publicKey,
    vaa as any,
    signatureSet.publicKey,
  );
  for (let i = 0; i < verifyIxs.length; i += 2) {
    const tx = new Transaction().add(...verifyIxs.slice(i, i + 2));
    await sendAndPoll(connection, tx, [payer, signatureSet]);
  }
  const postTx = new Transaction().add(
    coreUtils.createPostVaaInstruction(connection, core, payer.publicKey, vaa as any, signatureSet.publicKey),
  );
  await sendAndPoll(connection, postTx, [payer]);
  return postedVaaKey;
}

/** Deliver a posted VAA to the uab-receiver, which re-emits CrossChainAnnouncement. */
export async function receiveAnnouncementOnSolana(postedVaaKey: PublicKey): Promise<string> {
  const { uabReceiver, payer } = solCtx();
  const config = configPda();
  const programId = new PublicKey(SOL.uabReceiver);
  const processed = PublicKey.findProgramAddressSync(
    [Buffer.from("processed"), postedVaaKey.toBuffer()],
    programId,
  )[0];
  return uabReceiver.methods
    .receiveAnnouncement()
    .accountsPartial({
      config,
      postedVaa: postedVaaKey,
      processed,
      relayer: payer.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Read the 96-byte payload out of a posted VAA account. */
export async function readPostedVaaPayload(postedVaaKey: PublicKey): Promise<Uint8Array> {
  const { connection } = solCtx();
  const info = await connection.getAccountInfo(postedVaaKey);
  if (!info) throw new Error("posted VAA account not found");
  const data = info.data;
  const len = data.readUInt32LE(91);
  return new Uint8Array(data.subarray(95, 95 + len));
}
