/**
 * Codec for the 96-byte cross-chain announcement payload (spec/payload-format.md).
 *
 *  [0]      view_tag        (1)
 *  [1..34)  ephemeral_pubkey(33)
 *  [34..66) stealth_address (32, left-padded)
 *  [66..68) source_chain_id (2, big-endian Wormhole chain id)
 *  [68..72) scheme_id       (4, big-endian)
 *  [72..96) metadata        (24)
 */

export interface UabPayload {
  viewTag: number;
  ephemeralPubKey: Uint8Array; // 33
  stealthAddress: Uint8Array; // 32 (left-padded)
  sourceChainId: number;
  schemeId: number;
  metadata: Uint8Array; // 24
}

export function decodePayload(bytes: Uint8Array): UabPayload {
  if (bytes.length !== 96) throw new Error(`payload must be 96 bytes, got ${bytes.length}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    viewTag: bytes[0],
    ephemeralPubKey: bytes.slice(1, 34),
    stealthAddress: bytes.slice(34, 66),
    sourceChainId: dv.getUint16(66, false),
    schemeId: dv.getUint32(68, false),
    metadata: bytes.slice(72, 96),
  };
}

const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");

/** Human-readable view of a decoded payload (low 20 bytes is the EVM-style stealth address). */
export function describePayload(p: UabPayload): Record<string, unknown> {
  return {
    viewTag: p.viewTag,
    sourceChainId: p.sourceChainId,
    schemeId: p.schemeId,
    ephemeralPubKey: hex(p.ephemeralPubKey),
    stealthAddress32: hex(p.stealthAddress),
    stealthAddressEvm: hex(p.stealthAddress.slice(12)),
    metadata: hex(p.metadata),
  };
}
