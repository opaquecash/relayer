/**
 * Phase 5 acceptance (spec/relayer-market.md): two independent relayer nodes fulfil a
 * gas-private submission. Runs on an anvil fork of Sepolia (real deployed
 * RelayerRegistry bytecode, free ETH, deterministic) — the Phase 3.2 pattern.
 *
 *   SEPOLIA_RPC_URL=... npx tsx scripts/acceptance-gas-private.ts
 *
 * Flow: fork Sepolia -> register operator A and B (stake) via the node binary ->
 * start two node processes (separate gateways) -> a funder createJob's a real
 * StealthAddressAnnouncer.announce as the hidden payload -> advertise to both
 * gateways -> collect + verify bids from both -> select a stake-weighted winner ->
 * deliver the sealed payload -> the winning node accept+submits on the fork ->
 * assert jobs(jobId).submitted and that the escrow emitted the Announcement.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import {
  prepareJob,
  buildPayloadEnvelope,
  verifyBids,
  selectWinner,
  getBids,
  postAdvert,
  postPayload,
  type Bid,
  type RegistryReaders,
} from "../../sdk/packages/relayer-client/dist/index.js";

const RPC = "http://127.0.0.1:8545";
const REGISTRY = "0x5fA252e2D22058a4ec3420573a3B3A5dca025837" as Address;
const ANNOUNCER = "0x840f72249A8bF6F10b0eB64412E315efBD730865" as Address;
const NODE_BIN = new URL("../rust/target/release/opaque-relayer", import.meta.url).pathname;

// anvil default mnemonic accounts.
const FUNDER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const OP_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const OP_B = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;

const fork = defineChain({
  id: 11155111,
  name: "Sepolia fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const registryAbi = [
  { type: "function", name: "freeStakeOf", stateMutability: "view", inputs: [{ name: "r", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "relayers", stateMutability: "view", inputs: [{ name: "r", type: "address" }], outputs: [
    { name: "stake", type: "uint256" }, { name: "bonded", type: "uint256" }, { name: "unstaking", type: "uint256" },
    { name: "unstakeAvailableAt", type: "uint64" }, { name: "x25519PubKey", type: "bytes32" }, { name: "endpoint", type: "string" },
  ] },
  { type: "function", name: "jobs", stateMutability: "view", inputs: [{ name: "id", type: "bytes32" }], outputs: [{ components: [
    { name: "creator", type: "address" }, { name: "relayer", type: "address" }, { name: "fee", type: "uint96" },
    { name: "payloadHash", type: "bytes32" }, { name: "deadline", type: "uint64" }, { name: "submitted", type: "bool" }, { name: "closed", type: "bool" },
  ], name: "", type: "tuple" }] },
] as const;

const announcerAbi = [
  { type: "function", name: "announce", stateMutability: "nonpayable", inputs: [
    { name: "schemeId", type: "uint256" }, { name: "stealthAddress", type: "address" },
    { name: "ephemeralPubKey", type: "bytes" }, { name: "metadata", type: "bytes" },
  ], outputs: [] },
] as const;

const procs: ChildProcess[] = [];
function run(label: string, args: string[], env: Record<string, string>): ChildProcess {
  const p = spawn(NODE_BIN, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  p.stderr!.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  procs.push(p);
  return p;
}
async function runToExit(label: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(NODE_BIN, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout!.on("data", (d) => { out += d; process.stdout.write(`[${label}] ${d}`); });
    p.stderr!.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited ${code}: ${out}`))));
  });
}

function cleanup() {
  for (const p of procs) try { p.kill("SIGKILL"); } catch { /* ignore */ }
}

async function main() {
  const sepolia = process.env.SEPOLIA_RPC_URL;
  if (!sepolia) throw new Error("set SEPOLIA_RPC_URL to fork from");

  console.log("starting anvil fork of Sepolia...");
  const anvil = spawn("anvil", ["--fork-url", sepolia, "--port", "8545", "--silent"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  procs.push(anvil);
  anvil.stderr!.on("data", (d) => process.stdout.write(`[anvil] ${d}`));

  const publicClient = createPublicClient({ chain: fork, transport: http(RPC) });
  // Wait for anvil.
  for (let i = 0; i < 40; i++) {
    try { await publicClient.getBlockNumber(); break; } catch { await sleep(500); }
  }
  console.log("fork up at block", await publicClient.getBlockNumber());

  const commonEnv = {
    ETH_RPC: RPC,
    ETH_REGISTRY: REGISTRY,
    // No solana flags: this run is EVM-only.
  };

  // Register both operators (the node derives + registers its own x25519 box key).
  console.log("registering operator A and B...");
  await runToExit("register-A", ["--eth-key", OP_A, "register", "--stake", parseEther("0.02").toString()], commonEnv);
  await runToExit("register-B", ["--eth-key", OP_B, "register", "--stake", parseEther("0.02").toString()], commonEnv);

  const opA = privateKeyToAccount(OP_A).address;
  const opB = privateKeyToAccount(OP_B).address;
  console.log("free stake A:", await publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "freeStakeOf", args: [opA] }));
  console.log("free stake B:", await publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "freeStakeOf", args: [opB] }));

  // Start two independent nodes on separate gateways.
  console.log("starting two relayer nodes...");
  run("nodeA", ["--eth-key", OP_A, "start", "--gateway", "127.0.0.1:8788", "--listen", "/ip4/127.0.0.1/tcp/4031"], commonEnv);
  run("nodeB", ["--eth-key", OP_B, "start", "--gateway", "127.0.0.1:8789", "--listen", "/ip4/127.0.0.1/tcp/4032"], commonEnv);
  await sleep(3000);
  const gwA = { baseUrl: "http://127.0.0.1:8788" };
  const gwB = { baseUrl: "http://127.0.0.1:8789" };

  // The hidden action: a permissionless StealthAddressAnnouncer.announce, made by the escrow.
  const calldata = encodeFunctionData({
    abi: announcerAbi,
    functionName: "announce",
    args: [1n, "0x000000000000000000000000000000000000bEEF", `0x02${"11".repeat(32)}`, "0xe1"],
  });
  const fee = parseEther("0.0005");
  const deadline = Number(await publicClient.getBlock().then((b) => b.timestamp)) + 1800;
  const prepared = prepareJob({ chain: 2, target: ANNOUNCER, calldata }, { fee, deadline, registry: REGISTRY });
  console.log("job", prepared.jobId);

  // Fund the escrow from the funder.
  const funder = createWalletClient({ account: privateKeyToAccount(FUNDER), chain: fork, transport: http(RPC) });
  const fundHash = await funder.sendTransaction(prepared.evmCreateJob!);
  await publicClient.waitForTransactionReceipt({ hash: fundHash });
  console.log("escrow funded:", fundHash);

  // Advertise to BOTH nodes' gateways (no libp2p peering needed for the acceptance).
  await postAdvert(gwA, prepared.advert);
  await postAdvert(gwB, prepared.advert);

  // Collect bids from both gateways.
  let bids: Bid[] = [];
  for (let i = 0; i < 20 && bids.length < 2; i++) {
    await sleep(1000);
    const [a, b] = await Promise.all([getBids(gwA, prepared.jobId), getBids(gwB, prepared.jobId)]);
    const byOp = new Map<string, Bid>();
    for (const bid of [...a, ...b]) byOp.set(bid.operator.toLowerCase(), bid);
    bids = [...byOp.values()];
  }
  console.log(`collected ${bids.length} bid(s):`, bids.map((b) => b.operator));
  if (bids.length < 2) throw new Error("expected both nodes to bid");

  const readers: RegistryReaders = {
    freeStakeOf: (op) => publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "freeStakeOf", args: [op as Address] }),
    registeredKey: async (op) => {
      const r = await publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "relayers", args: [op as Address] });
      return r[4] as Hex;
    },
  };
  const verified = await verifyBids(bids, fee, readers);
  console.log(`${verified.length} verified bid(s)`);
  const winner = selectWinner(verified, () => 0.5);
  if (!winner) throw new Error("no valid winner");
  console.log("winner:", winner.bid.operator);

  // Deliver the sealed payload to the winner's gateway.
  const winnerGw = winner.bid.operator.toLowerCase() === opA.toLowerCase() ? gwA : gwB;
  const envelope = buildPayloadEnvelope(winner.bid, { chain: 2, target: ANNOUNCER, calldata });
  await postPayload(winnerGw, envelope);
  console.log("payload delivered to winner gateway");

  // Wait for the winning node to accept + submit on-chain.
  let submitted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const job = await publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "jobs", args: [prepared.jobId] });
    if (job.submitted) { submitted = true; break; }
  }
  if (!submitted) throw new Error("job was not submitted before timeout");

  const job = await publicClient.readContract({ address: REGISTRY, abi: registryAbi, functionName: "jobs", args: [prepared.jobId] });
  console.log("\nACCEPTANCE PASS:");
  console.log("  job submitted:", job.submitted, "closed:", job.closed);
  console.log("  on-chain relayer:", job.relayer);
  console.log("  matches winner:", job.relayer.toLowerCase() === winner.bid.operator.toLowerCase());
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((e) => { console.error("ACCEPTANCE FAIL:", e.message ?? e); cleanup(); process.exit(1); });
