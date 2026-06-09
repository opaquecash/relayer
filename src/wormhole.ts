import { deserialize } from "@wormhole-foundation/sdk";
import { WORMHOLESCAN } from "./config.js";

/**
 * Poll the Wormholescan Testnet API for the signed VAA of a published message.
 * `emitterHex` is the 32-byte Wormhole emitter address as hex (no 0x).
 */
export async function fetchVaaBytes(
  whChain: number,
  emitterHex: string,
  sequence: bigint,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const url = `${WORMHOLESCAN}/api/v1/vaas/${whChain}/${emitterHex}/${sequence.toString()}`;
  const deadline = Date.now() + timeoutMs;

  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = (await res.json()) as { data?: { vaa?: string } };
        const b64 = body?.data?.vaa;
        if (b64) return new Uint8Array(Buffer.from(b64, "base64"));
      }
    } catch {
      /* transient; retry */
    }
    if (Date.now() > deadline) {
      throw new Error(`VAA not available after ${Math.round(timeoutMs / 1000)}s: ${url}`);
    }
    if (attempt % 6 === 0) {
      console.log(`  …waiting for guardians (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Parse raw VAA bytes into the SDK VAA object (opaque payload). */
export function parseVaa(bytes: Uint8Array) {
  return deserialize("Uint8Array", bytes);
}
