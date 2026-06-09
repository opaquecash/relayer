import { ethers } from "ethers";
import { ETH, sepoliaKey, sepoliaRpc } from "./config.js";

const UAB_SENDER_ABI = [
  "function announceWithRelay(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata, uint8 consistencyLevel) payable returns (uint64)",
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
  "event RelayedAnnouncement(uint64 indexed sequence, bytes payload)",
];

const UAB_RECEIVER_ABI = [
  "function receiveAnnouncement(bytes encodedVaa)",
  "function setExpectedEmitter(uint16 chainId, bytes32 emitter)",
  "function expectedEmitter() view returns (bytes32)",
  "function expectedEmitterChain() view returns (uint16)",
  "function admin() view returns (address)",
  "event CrossChainAnnouncement(uint16 indexed sourceChain, bytes32 indexed sourceEmitter, uint64 sequence, bytes payload)",
];

const CORE_ABI = ["function messageFee() view returns (uint256)"];

export function evmCtx() {
  const provider = new ethers.JsonRpcProvider(sepoliaRpc());
  const wallet = new ethers.Wallet(sepoliaKey(), provider);
  const sender = new ethers.Contract(ETH.uabSender, UAB_SENDER_ABI, wallet);
  const receiver = new ethers.Contract(ETH.uabReceiver, UAB_RECEIVER_ABI, wallet);
  const core = new ethers.Contract(ETH.wormholeCore, CORE_ABI, provider);
  return { provider, wallet, sender, receiver, core };
}

/** The Wormhole emitter (32-byte hex, no 0x) for the Sepolia UABSender. */
export function ethEmitterHex(): string {
  return ethers.zeroPadValue(ETH.uabSender, 32).slice(2).toLowerCase();
}

/** Call announceWithRelay; return the Wormhole emitter sequence of the published message. */
export async function announceWithRelay(args: {
  schemeId: bigint;
  stealthAddress: string;
  ephemeralPubKey: string;
  metadata: string;
  consistencyLevel: number;
}): Promise<bigint> {
  const { sender, core } = evmCtx();
  const fee: bigint = await core.messageFee();
  const tx = await sender.announceWithRelay(
    args.schemeId,
    args.stealthAddress,
    args.ephemeralPubKey,
    args.metadata,
    args.consistencyLevel,
    { value: fee },
  );
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = sender.interface.parseLog(log);
      if (parsed?.name === "RelayedAnnouncement") return BigInt(parsed.args.sequence);
    } catch {
      /* not our event */
    }
  }
  throw new Error("RelayedAnnouncement not found in receipt");
}

/** Submit a Solana-origin VAA to the Sepolia UABReceiver; return the CrossChainAnnouncement payload hex. */
export async function receiveAnnouncementOnEth(vaaBytes: Uint8Array): Promise<string> {
  const { receiver } = evmCtx();
  const tx = await receiver.receiveAnnouncement("0x" + Buffer.from(vaaBytes).toString("hex"));
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = receiver.interface.parseLog(log);
      if (parsed?.name === "CrossChainAnnouncement") return parsed.args.payload as string;
    } catch {
      /* not our event */
    }
  }
  throw new Error("CrossChainAnnouncement not emitted");
}
