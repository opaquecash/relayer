# Opaque Relayer

[![CI](https://github.com/opaquecash/relayer/actions/workflows/relayer-test.yml/badge.svg)](https://github.com/opaquecash/relayer/actions/workflows/relayer-test.yml)

This repo hosts two things:

- **`rust/` — `opaque-relayer`**, the permissionless node for the gas-private submission
  market (spec [`relayer-market.md`](https://github.com/opaquecash/spec/blob/main/relayer-market.md)).
  This is the Phase 5 successor and the supported way to run a relayer. See
  [`rust/README.md`](./rust/README.md).
- **The legacy TypeScript UAB/ONS delivery scripts** (this directory), kept for reference
  and as the current Wormhole VAA delivery path until the keeper duty (below) lands in the
  node.

**VAA delivery migration status:** the relayer-market spec assigns UAB/ONS VAA delivery to
the node as a fee-less keeper duty (`relayer-market.md` §4.4). That keeper loop (watch
Wormholescan for the Opaque emitters, post + deliver signed VAAs) is the next increment on
`opaque-relayer`; until it ships, the TypeScript scripts here remain the delivery path and
are **not yet decommissioned**. The market itself (gas-private submission) is live and
acceptance-tested.

---

## Legacy UAB/ONS delivery (TypeScript)

Off-chain relay for the **Universal Announcement Bus** (UAB): it fetches the Wormhole VAA for a
cross-chain stealth announcement and delivers it to the destination chain's receiver. Wormhole's
automatic relayer is EVM-only, so any leg touching Solana is delivered here. The relay is
**liveness-only** — it cannot forge or alter a VAA (guardian-signed), only deliver it.

Spec: [`spec/UAB.md`](https://github.com/opaquecash/spec/blob/main/UAB.md) ·
payload: [`spec/payload-format.md`](https://github.com/opaquecash/spec/blob/main/payload-format.md).

## Flow

```
source announce  →  Wormhole Core  →  guardians sign (VAA)  →  relay fetches VAA
                                                                      │
   Sol→Eth: UABReceiver.receiveAnnouncement(vaa)  ◀───────────────────┤
   Eth→Sol: post VAA to core bridge → uab_receiver.receive_announcement
```

## Deployments (Testnet)

| | Ethereum Sepolia | Solana devnet |
|---|---|---|
| Wormhole Core | `0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78` | `3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5` |
| Wormhole chain id | 2 | 1 |
| UAB sender | `0x872787c0BD1A0C71e6D1be5a144EB044e0CB2069` (UABSender) | `HGFn2fH7bVQ5cSuiG52NjzN9m11YrB3FZUfoN9b9A5jf` (stealth_announcer · `announce_with_relay`) |
| UAB receiver | `0x9eF189f7a263F870Cf80f9A89d1349A6AF7b15cF` (UABReceiver) | `7d4Sbmmpy954JwSNdjwf31pgbeWUQqwpgNdte5iy3vuM` (uab_receiver) |
| Wormhole emitter | `0x000…872787c0bd1a0c71e6d1be5a144eb044e0cb2069` | PDA `Ay5gspEYbCwKg2feCipJyrFWBp1W6EwScwDbnW6aTMKJ` (`0x94170201…`) |

## Setup

```bash
npm install
cp .env.example .env   # set SEPOLIA_RPC_URL, SEPOLIA_PRIVATE_KEY, SOLANA_KEYPAIR
npm run setup          # cross-register emitters (admin only; idempotent)
```

`setup` points the Solana `uab_receiver` config at the Sepolia `UABSender` and calls
`UABReceiver.setExpectedEmitter` with the Solana emitter PDA.

## End-to-end tests

```bash
npm run e2e:sol-to-eth   # announce on Solana → deliver to Sepolia (fast)
npm run e2e:eth-to-sol   # announce on Sepolia → post + deliver on Solana (~minutes; waits for finality)
```

Each script announces a sample stealth transfer, waits for the guardian VAA (Wormholescan
Testnet), delivers it, and verifies the 96-byte payload round-trips byte-for-byte.

## Layout

```
src/config.ts     addresses, RPCs, key loading, IDLs
src/payload.ts    96-byte payload codec
src/wormhole.ts   VAA fetch (Wormholescan) + parse
src/evm.ts        UABSender / UABReceiver (ethers)
src/solana.ts     announce_with_relay, post VAA, uab_receiver (anchor + sdk-solana-core)
scripts/          setup + the two e2e flows
idl/              uab_receiver + stealth_announcer IDLs (from `anchor build`)
```

## License

AGPL-3.0.
