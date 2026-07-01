# opaque-relayer

A permissionless node for the Opaque gas-private submission market
([`spec/relayer-market.md`](https://github.com/opaquecash/spec/blob/main/relayer-market.md)).
The node joins the libp2p GossipSub mesh on `opaque/jobs/v1`, serves an HTTP intake
gateway, bids on jobs it can fulfil, and on receiving the encrypted payload runs
accept-then-submit on the matching chain. It is **liveness-only**: the on-chain escrow
verifies the payload against its commitment and pays the fee atomically with execution,
so a node can neither forge a submission nor take the fee without doing the work, and a
node that accepts then stalls is slashed.

It also performs the **UAB/ONS VAA delivery** keeper duty that the Phase-1 TypeScript
relay used to do (watch Wormholescan for the Opaque emitters, deliver signed VAAs to
the destination receivers), so the same binary anyone runs provides that liveness.

## Build

```bash
cd rust
cargo build --release
```

## Register

Stake on each chain you want to serve (amounts in base units: wei / lamports):

```bash
opaque-relayer \
  --eth-key 0x<operator-privkey> \
  --sol-keypair ~/.config/solana/id.json \
  register --stake 100000000 --endpoint http://my-gateway:8787
```

The registered x25519 key (printed) is derived deterministically from the operator key,
so it is stable across restarts and matches what bids advertise.

## Run a node

```bash
opaque-relayer \
  --eth-rpc  https://ethereum-sepolia-rpc.publicnode.com \
  --sol-rpc  https://api.devnet.solana.com \
  --eth-key  0x<operator-privkey> \
  --sol-keypair ~/.config/solana/id.json \
  start --min-fee-eth 0.0005 --gateway 127.0.0.1:8787 \
        --listen /ip4/0.0.0.0/tcp/4011 \
        --peer /ip4/<other-node>/tcp/4011/p2p/<peer-id>
```

Defaults target the testnet deployments: Sepolia `RelayerRegistry`
`0x5fA252e2D22058a4ec3420573a3B3A5dca025837`, devnet `relayer-registry`
`E4xmYaAU31dbNTbhfMfp2F24b48DAxJigvZTVbsKJREg`.

## HTTP gateway

For clients without a libp2p stack (browsers, the SDK):

| Method | Path | Body / result |
|---|---|---|
| `POST` | `/v1/jobs` | an advert JSON; re-gossiped to the mesh |
| `GET` | `/v1/jobs/{jobId}/bids` | bids the node has seen for the job |
| `POST` | `/v1/jobs/{jobId}/payload` | a payload envelope JSON; re-gossiped |
| `POST` | `/v1/sweep` | a gasless-sweep submission (see below) → `{ ok, tx }` |
| `GET` | `/v1/sweep/info` | per-chain operator + EVM forwarder the client builds against |
| `GET` | `/v1/health` | `ok` |

## Gasless token sweep (fee-in-token)

A one-time stealth address that received an ERC-20/SPL payment holds the token but no
native gas, so it cannot move it. `POST /v1/sweep` lets the node submit an owner-signed
sweep, front the gas, and be reimbursed the fee **in that token**
([`relayer-market.md` §9](https://github.com/opaquecash/spec/blob/main/relayer-market.md)).
This is **escrow-free and outside the job market** — no advert, bid, or payload delivery,
just a single synchronous submit. The authorization is self-contained: destination, amount,
and fee are all signed by the stealth key, so the node can only execute exactly what was
authorized or nothing.

Clients build the request with `OpaqueClient.buildGaslessTokenSweep(...)` and post it via
`@opaquecash/relayer-client`'s `postGaslessSweep(gateway, gaslessSweepSubmission(sweep))`.

Request body (discriminated by `chain`):

```jsonc
// EVM: forwarder call. `data` is the owner-signed sweepWithPermit calldata.
{ "chain": "ethereum", "to": "0x<StealthTokenSweep>", "data": "0x…" }
// Solana: a tx the stealth key already partially signed, relayer is fee payer.
{ "chain": "solana", "transactionBase64": "…" }
```

Guards: EVM sweeps must target the configured `--eth-forwarder`
(`ETH_FORWARDER`, default the Sepolia `StealthTokenSweep`
`0xdb8103231c8b2488Faf00427Cb1241bbe62A1410`); Solana sweeps must name this node as fee
payer and may only touch the SPL Token / Token-2022 / Associated-Token / Compute-Budget
programs, bounding the gas the node can be asked to front. The node fronts gas regardless
of whether the in-token fee covers it, so operators SHOULD only expose `/v1/sweep` for
tokens whose fee they price above their gas cost.

## Layout

```
src/
  main.rs           CLI (register / start)
  config.rs         RPC + registry addresses, keypair loading
  job.rs            wire types + payload-commitment hashing (EVM + Solana)
  crypto.rs         box identity, NaCl seal/open, EVM bid sign/recover
  p2p.rs            libp2p GossipSub mesh
  gateway.rs        axum HTTP intake
  market.rs         node orchestration (advert -> bid; payload -> accept+submit)
  submitter/
    mod.rs          Submitter trait + on-chain job view
    ethereum.rs     alloy (RelayerRegistry)
    solana.rs       solana-sdk (relayer-registry)
```

The legacy TypeScript UAB/ONS delivery scripts remain at the repo root for reference;
this Rust binary is their permissionless successor.
