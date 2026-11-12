import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { registerStandardPrograms, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, COMPUTE_BUDGET_PROGRAM } from "../src/agent-integration/standard-programs.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import { buildDemoRegistry } from "../demo/policy.js";
import type { Policy } from "../src/policy/types.js";

const registry = registerStandardPrograms(buildDemoRegistry());
const payer = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const source = Keypair.generate().publicKey;
const destination = Keypair.generate().publicKey;
const SYSTEM = SystemProgram.programId.toBase58();

const encode = (ixs: TransactionInstruction[], legacy = false) => {
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs });
  return Buffer.from(new VersionedTransaction(legacy ? message.compileToLegacyMessage() : message.compileToV0Message()).serialize()).toString("base64");
};

function tokenIx(program: string, opts: { amount?: bigint; opcode?: number; extraAccounts?: PublicKey[]; mintAccount?: PublicKey } = {}) {
  const data = Buffer.alloc(10);
  data[0] = opts.opcode ?? 12;
  data.writeBigUInt64LE(opts.amount ?? 5_000_000n, 1);
  data[9] = 6;
  const keys = [source, opts.mintAccount ?? mint, destination, payer].map((pubkey, i) => ({ pubkey, isSigner: i === 3, isWritable: i !== 1 && i !== 3 }));
  for (const extra of opts.extraAccounts ?? []) keys.push({ pubkey: extra, isSigner: false, isWritable: false });
  return new TransactionInstruction({ programId: new PublicKey(program), keys, data });
}

const policy = (over: Partial<Policy> = {}): Policy => ({
  policyId: "p",
  programAllowlist: [TOKEN_PROGRAM, TOKEN_2022_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM],
  destinationAllowlist: [], allowAnyDestination: true,
  maxAmountPerTransaction: { [mint.toBase58()]: "10000000" },
  maxAmountPerDay: { [mint.toBase58()]: "50000000" },
  ...over
});

test("a TransferChecked token payment is decoded with its mint as the asset and checked against that mint's limits", async () => {
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const decoded = await parseAndDecodeTransaction(encode([tokenIx(program)]), registry);
    const [instruction] = decoded.instructions;
    assert.equal(instruction.mode, "interpolated");
    assert.equal(instruction.asset, mint.toBase58());
    assert.equal(instruction.amount, 5_000_000n);
    assert.equal(instruction.destination, destination.toBase58());
    assert.equal(evaluatePolicy(decoded, policy()).decision, "ALLOW");
    const over = await parseAndDecodeTransaction(encode([tokenIx(program, { amount: 10_000_001n })]), registry);
    assert.equal(evaluatePolicy(over, policy()).decision, "NEEDS_REVIEW");
  }
});

test("a token the policy has no limit for goes to review", async () => {
  const other = Keypair.generate().publicKey;
  const decoded = await parseAndDecodeTransaction(encode([tokenIx(TOKEN_PROGRAM, { mintAccount: other })]), registry);
  const result = evaluatePolicy(decoded, policy());
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.match(result.reasons.join(" "), /no per-transaction limit for asset/);
});

test("plain Transfer (no mint), and transfers with extra accounts, are not verified and go to review", async () => {
  const plain = await parseAndDecodeTransaction(encode([tokenIx(TOKEN_PROGRAM, { opcode: 3 })]), registry);
  assert.equal(plain.instructions[0].mode, "raw_dump", "unchecked Transfer has no knowable asset");
  assert.equal(evaluatePolicy(plain, policy()).decision, "NEEDS_REVIEW");
  const multisig = await parseAndDecodeTransaction(encode([tokenIx(TOKEN_2022_PROGRAM, { extraAccounts: [Keypair.generate().publicKey] })]), registry);
  assert.equal(multisig.instructions[0].mode, "raw_dump", "extra accounts (multisig signer, transfer hook) fail the account-count check");
  assert.equal(evaluatePolicy(multisig, policy()).decision, "NEEDS_REVIEW");
});

test("ComputeBudget instructions decode, so a clean payment with a budget is not sent to review", async () => {
  const decoded = await parseAndDecodeTransaction(encode([ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), tokenIx(TOKEN_PROGRAM)]), registry);
  assert.deepEqual(decoded.instructions.map((i) => i.mode), ["interpolated", "interpolated"]);
  assert.equal(decoded.priorityFee, undefined, "a limit with no price costs no priority fee");
  assert.equal(evaluatePolicy(decoded, policy()).decision, "ALLOW");
});

test("a priority fee set through ComputeBudget is computed and capped, on legacy and v0", async () => {
  for (const legacy of [false, true]) {
    const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 })];
    const decoded = await parseAndDecodeTransaction(encode([...budget, tokenIx(TOKEN_PROGRAM)], legacy), registry);
    assert.equal(decoded.priorityFee, 1000n, "50,000 units x 20,000 micro-lamports = 1,000 lamports");
    assert.equal(evaluatePolicy(decoded, policy()).decision, "NEEDS_REVIEW", "no priority-fee limit configured: review");
    assert.equal(evaluatePolicy(decoded, policy({ maxPriorityFeePerTransaction: "1000" })).decision, "ALLOW");
    assert.equal(evaluatePolicy(decoded, policy({ maxPriorityFeePerTransaction: "999" })).decision, "NEEDS_REVIEW");
  }
});

test("a price with no explicit limit uses the runtime default (200,000 per ordinary instruction, 3,000 per built-in one), rounded up", async () => {
  const decoded = await parseAndDecodeTransaction(encode([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 3 }), tokenIx(TOKEN_PROGRAM)]), registry);
  assert.equal(decoded.priorityFee, 1n, "(3,000 for ComputeBudget + 200,000) x 3 / 1,000,000 = 0.6, rounded up to 1");
  const two = await parseAndDecodeTransaction(encode([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000 }), tokenIx(TOKEN_PROGRAM), tokenIx(TOKEN_PROGRAM)]), registry);
  assert.equal(two.priorityFee, 403_000n, "3,000 + 2 x 200,000 units at 1 lamport per unit; matches the fee charged on mainnet");
});

test("production mode refuses to start without API keys, named reviewers and an explicit database", () => {
  const run = (env: Record<string, string>) => spawnSync(process.execPath, ["dist/src/index.js"], { env: { PATH: process.env.PATH ?? "", PORT: "0", ...env }, encoding: "utf8", timeout: 20_000 });
  const none = run({ AGENTGUARD_PRODUCTION: "true" });
  assert.notEqual(none.status, 0);
  for (const expected of [/REQUIRE_API_KEYS=true/, /REVIEW_REQUIRE_REVIEWERS=true/, /AGENTGUARD_DB_PATH/]) assert.match(none.stderr, expected);
  const partial = run({ AGENTGUARD_PRODUCTION: "true", REQUIRE_API_KEYS: "true", AGENTGUARD_DB_PATH: "unused.sqlite" });
  assert.notEqual(partial.status, 0);
  assert.match(partial.stderr, /REVIEW_REQUIRE_REVIEWERS=true/);
  assert.doesNotMatch(partial.stderr, /REQUIRE_API_KEYS=true \(/);
  assert.notEqual(run({ AGENTGUARD_PRODUCTION: "yes" }).status, 0, "a typo must not silently mean non-production");
});

test("a ComputeBudget instruction padded with trailing bytes is still read, as the runtime reads it", async () => {
  // Seen on mainnet: SetComputeUnitLimit sent as 9 bytes instead of 5. Ignoring it would let padding hide the limit.
  const padded = (opcode: number, value: bigint, size: number) => {
    const data = Buffer.alloc(size);
    data[0] = opcode;
    if (size === 9 && opcode === 3) data.writeBigUInt64LE(value, 1); else data.writeUInt32LE(Number(value), 1);
    return new TransactionInstruction({ programId: new PublicKey(COMPUTE_BUDGET_PROGRAM), keys: [], data });
  };
  const decoded = await parseAndDecodeTransaction(encode([padded(2, 1_000_000n, 9), padded(3, 5n, 9), tokenIx(TOKEN_PROGRAM)], true), registry);
  assert.equal(decoded.priorityFee, 5n, "1,000,000 units x 5 micro-lamports");
});

test("a transaction of only compute budget settings goes to review, since it does nothing but cost the fee payer", async () => {
  const onlyBudget = await parseAndDecodeTransaction(encode([ComputeBudgetProgram.setComputeUnitLimit({ units: 300 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })]), registry);
  const result = evaluatePolicy(onlyBudget, policy({ maxPriorityFeePerTransaction: "1000" }));
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.match(result.reasons.join(" "), /only compute budget settings/);
  // The same settings next to a real, verified instruction are fine.
  const withPayment = await parseAndDecodeTransaction(encode([ComputeBudgetProgram.setComputeUnitLimit({ units: 300 }), tokenIx(TOKEN_PROGRAM)]), registry);
  assert.equal(evaluatePolicy(withPayment, policy()).decision, "ALLOW");
});
