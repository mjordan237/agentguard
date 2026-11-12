import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createServer } from "../src/api/server.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { registerStandardPrograms, TOKEN_PROGRAM } from "../src/agent-integration/standard-programs.js";
import { ASSOCIATED_TOKEN_PROGRAM } from "../src/agent-integration/payment-extras.js";
import { JUPITER_V6_PROGRAM } from "../src/agent-integration/jupiter.js";
import { checkSwapsBySimulation, type AccountState, type SwapSimulator } from "../src/gateway/swap-simulation.js";
import { WRAPPED_SOL_MINT } from "../src/policy/swap-rules.js";
import { parsePolicy } from "../src/policy/validate.js";
import { buildDemoRegistry } from "../demo/policy.js";
import { USDC, ata, sellSol, type Built } from "./jupiter-builders.js";

const registry = registerStandardPrograms(buildDemoRegistry());
const SYSTEM = SystemProgram.programId.toBase58();
const RENT = 2_039_280n;
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

/** A 165-byte SPL token account. */
function tokenAccount(mint: string, owner: PublicKey, amount: bigint, delegate?: PublicKey): AccountState {
  const data = Buffer.alloc(165);
  new PublicKey(mint).toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  if (delegate) { data.writeUInt32LE(1, 72); delegate.toBuffer().copy(data, 76); }
  data[108] = 1;
  return { programOwner: TOKEN_PROGRAM, lamports: RENT, data };
}
const wallet = (lamports: bigint): AccountState => ({ programOwner: SYSTEM, lamports, data: new Uint8Array(0) });

/** A simulator whose before and after states are given per address; anything not listed does not exist. */
function simulator(before: Record<string, AccountState | null>, after: Record<string, AccountState | null>, err: unknown = null): SwapSimulator {
  return {
    async snapshot(addresses) { return addresses.map((address) => before[address] ?? null); },
    async simulate(_tx, addresses) { return { err, accounts: addresses.map((address) => (address in after ? after[address]! : before[address] ?? null)) }; }
  };
}

async function decode(built: Built, feePayer = Keypair.generate().publicKey) {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: built.instructions }).compileToV0Message());
  const transactionBase64 = Buffer.from(tx.serialize()).toString("base64");
  return { transactionBase64, decoded: await parseAndDecodeTransaction(transactionBase64, registry) };
}

/** Selling 1 SOL for USDC, as the chain would show it: 1 SOL leaves the signer, 150 USDC arrives. */
function honest(agent: PublicKey) {
  const usdc = ata(agent, USDC).toBase58();
  return {
    before: { [agent.toBase58()]: wallet(3_000_000_000n), [usdc]: tokenAccount(USDC, agent, 0n) },
    after: { [agent.toBase58()]: wallet(2_000_000_000n), [ata(agent, WRAPPED_SOL_MINT).toBase58()]: null, [usdc]: tokenAccount(USDC, agent, 150_000_000n) }
  };
}

test("an honest swap passes the simulation check, and reports the net change", async () => {
  const built = sellSol();
  const { transactionBase64, decoded } = await decode(built);
  const { before, after } = honest(built.agent);
  const check = await checkSwapsBySimulation(transactionBase64, decoded, simulator(before, after));
  assert.deepEqual(check.reasons, []);
  assert.deepEqual(check.netChange, { native: "-1000000000", [USDC]: "150000000" });
});

test("the simulation check catches what the instructions do not show", async () => {
  const built = sellSol();
  const agent = built.agent;
  const { transactionBase64, decoded } = await decode(built);
  const usdc = ata(agent, USDC).toBase58();
  // A token account of the signer's that the route names as one of its DEX accounts.
  const bonk = Keypair.generate().publicKey.toBase58();
  decoded.instructions.find((i) => i.swap)!.accounts.push(bonk);
  const thief = Keypair.generate().publicKey;
  const base = honest(agent);
  const cases: Array<[string, Record<string, AccountState | null>, Record<string, AccountState | null>, RegExp, unknown?]> = [
    ["another token drained", { ...base.before, [bonk]: tokenAccount(BONK, agent, 500n) }, { ...base.after, [bonk]: tokenAccount(BONK, agent, 0n) }, /loses 500 of DezX/],
    ["more SOL than the input", base.before, { ...base.after, [agent.toBase58()]: wallet(1_500_000_000n) }, /loses 1500000000 of native, more than the 1000000000/],
    ["a delegate granted", base.before, { ...base.after, [usdc]: tokenAccount(USDC, agent, 150_000_000n, thief) }, /gains a delegate/],
    ["an account handed over", { ...base.before, [bonk]: tokenAccount(BONK, agent, 0n) }, { ...base.after, [bonk]: tokenAccount(BONK, thief, 0n) }, /stops belonging to the signer/],
    ["less output than guaranteed", base.before, { ...base.after, [usdc]: tokenAccount(USDC, agent, 100_000_000n) }, /below the swap's guaranteed minimum of 149250000/],
    ["no output at all", base.before, { [agent.toBase58()]: wallet(2_000_000_000n) }, /receives (nothing|0) of EPjF/],
    ["a failed simulation", base.before, base.after, /fails in simulation/, { InstructionError: [4, { Custom: 6001 }] }]
  ];
  for (const [name, before, after, why, err] of cases) {
    const check = await checkSwapsBySimulation(transactionBase64, decoded, simulator(before, after, err ?? null));
    assert.ok(check.reasons.some((reason) => why.test(reason)), `${name}: expected ${why} in ${JSON.stringify(check.reasons)}`);
  }
});

test("a simulator that cannot be reached fails closed", async () => {
  const built = sellSol();
  const { transactionBase64, decoded } = await decode(built);
  const broken: SwapSimulator = { snapshot: async () => { throw new Error("RPC unavailable"); }, simulate: async () => ({ err: null, accounts: [] }) };
  const check = await checkSwapsBySimulation(transactionBase64, decoded, broken);
  assert.match(check.reasons[0] ?? "", /could not be simulated: RPC unavailable/);
});

test("a legacy route may spend its unnamed input from one asset only", async () => {
  const built = sellSol({ legacy: true });
  const agent = built.agent;
  const { transactionBase64, decoded } = await decode(built);
  const bonk = Keypair.generate().publicKey.toBase58();
  decoded.instructions.find((i) => i.swap)!.accounts.push(bonk);
  const base = honest(agent);
  const ok = await checkSwapsBySimulation(transactionBase64, decoded, simulator(base.before, base.after));
  assert.deepEqual(ok.reasons, []);
  const two = await checkSwapsBySimulation(transactionBase64, decoded, simulator({ ...base.before, [bonk]: tokenAccount(BONK, agent, 500n) }, { ...base.after, [bonk]: tokenAccount(BONK, agent, 0n) }));
  assert.ok(two.reasons.some((reason) => /loses 500 of DezX/.test(reason)), JSON.stringify(two.reasons));
});

test("with a simulator configured, the server sends a swap that fails the check to review and keeps the honest one", async () => {
  const built = sellSol();
  const agent = built.agent;
  const relayer = Keypair.generate().publicKey;
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: relayer, recentBlockhash: PublicKey.default.toBase58(), instructions: built.instructions }).compileToV0Message());
  const transactionBase64 = Buffer.from(tx.serialize()).toString("base64");
  const policy = parsePolicy({
    policyId: "swaps", programAllowlist: [JUPITER_V6_PROGRAM, SYSTEM, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM], destinationAllowlist: [Keypair.generate().publicKey.toBase58()],
    maxAmountPerTransaction: { native: "2000000000" }, maxAmountPerDay: { native: "10000000000" }, swapPairs: [{ inputMint: "native", outputMint: USDC }], maxSlippageBps: 100
  });
  const base = honest(agent);
  for (const [after, expected] of [[base.after, "ALLOW"], [{ ...base.after, [agent.toBase58()]: wallet(0n) }, "NEEDS_REVIEW"]] as const) {
    const app = createServer(new Map([["swaps", policy]]), registry, { baseUrl: "http://placeholder", swapSimulator: simulator(base.before, after) });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "a", policyId: "swaps", transactionBase64 }) });
      const body = await r.json() as any;
      assert.equal(body.decision, expected, JSON.stringify(body.reasons));
      assert.ok(body.simulation?.netChange?.native, "the net change is reported");
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    }
  }
});
