import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import type { DecodedInstructionSummary, DecodedTransactionSummary, Policy } from "../src/policy/types.js";

const PROGRAM = "11111111111111111111111111111111";
const VENDOR = "Vendor1111111111111111111111111111111111";
const OTHER_RECIPIENT = "Other111111111111111111111111111111111111";

const policy: Policy = {
  policyId: "demo",
  programAllowlist: [PROGRAM],
  destinationAllowlist: [], allowAnyDestination: true,
  maxAmountPerTransaction: {},
  maxAmountPerDay: {}
};

// Both limits are set for any asset a test moves: an asset with no limit goes to review.
const LIMITS = { maxAmountPerTransaction: { native: "1000000" }, maxAmountPerDay: { native: "1000000" } };

function transferInstruction(overrides: Partial<DecodedInstructionSummary> = {}): DecodedInstructionSummary {
  return {
    programId: PROGRAM,
    instructionName: "transfer",
    fields: {},
    mode: "interpolated",
    accounts: ["from", "to"],
    ...overrides
  };
}

test("allows a transaction whose program is on the allowlist", () => {
  const decoded: DecodedTransactionSummary = { feePayer: "fee-payer", instructions: [transferInstruction()] };
  const result = evaluatePolicy(decoded, policy);
  assert.equal(result.decision, "ALLOW");
});

test("flags a transaction touching a program outside the allowlist", () => {
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [{ programId: "UnknownProgram111111111111111111111111111", instructionName: "unknown", fields: {}, mode: "fallback", accounts: [] }]
  };
  const result = evaluatePolicy(decoded, policy);
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.ok(result.reasons.length > 0);
});

test("ignores destinationAllowlist entirely when it's empty", () => {
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [transferInstruction({ destination: OTHER_RECIPIENT, amount: 100n, asset: "native" })]
  };
  const result = evaluatePolicy(decoded, { ...policy, ...LIMITS });
  assert.equal(result.decision, "ALLOW");
});

test("allows a payment to a destination on the allowlist", () => {
  const restrictedPolicy: Policy = { ...policy, ...LIMITS, destinationAllowlist: [VENDOR] };
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [transferInstruction({ destination: VENDOR, amount: 100n, asset: "native" })]
  };
  const result = evaluatePolicy(decoded, restrictedPolicy);
  assert.equal(result.decision, "ALLOW");
});

test("flags a payment to a destination not on the allowlist", () => {
  const restrictedPolicy: Policy = { ...policy, destinationAllowlist: [VENDOR] };
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [transferInstruction({ destination: OTHER_RECIPIENT, amount: 100n, asset: "native" })]
  };
  const result = evaluatePolicy(decoded, restrictedPolicy);
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.match(result.reasons.join(), /not in the allowlist/);
});

test("flags a policy-relevant instruction whose destination couldn't be resolved, when an allowlist is configured", () => {
  const restrictedPolicy: Policy = { ...policy, destinationAllowlist: [VENDOR] };
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [transferInstruction({ destination: undefined, amount: 100n, asset: "native" })]
  };
  const result = evaluatePolicy(decoded, restrictedPolicy);
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.match(result.reasons.join(), /could not be resolved/);
});

test("allows an amount at or under the per-transaction limit", () => {
  const limitedPolicy: Policy = { ...policy, ...LIMITS, maxAmountPerTransaction: { native: "1000" } };
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [transferInstruction({ amount: 1000n, asset: "native" })]
  };
  const result = evaluatePolicy(decoded, limitedPolicy);
  assert.equal(result.decision, "ALLOW");
});

test("flags an amount over the per-transaction limit", () => {
  const limitedPolicy: Policy = { ...policy, maxAmountPerTransaction: { native: "1000" } };
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [transferInstruction({ amount: 1001n, asset: "native" })]
  };
  const result = evaluatePolicy(decoded, limitedPolicy);
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.match(result.reasons.join(), /exceeds the per-transaction limit/);
});

test("flags a transaction that would push today's total over the daily limit", () => {
  const limitedPolicy: Policy = { ...policy, maxAmountPerDay: { native: "1000" } };
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [transferInstruction({ amount: 400n, asset: "native" })]
  };
  const result = evaluatePolicy(decoded, limitedPolicy, { native: 700n }); // already spent 700 today
  assert.equal(result.decision, "NEEDS_REVIEW");
  assert.match(result.reasons.join(), /daily limit/);
});

test("allows a transaction that stays within today's remaining daily budget", () => {
  const limitedPolicy: Policy = { ...policy, ...LIMITS, maxAmountPerDay: { native: "1000" } };
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [transferInstruction({ amount: 200n, asset: "native" })]
  };
  const result = evaluatePolicy(decoded, limitedPolicy, { native: 700n }); // 700 + 200 = 900, under 1000
  assert.equal(result.decision, "ALLOW");
});

test("the per-transaction cap applies to the transaction total, so splitting a payment across instructions cannot slip under it", () => {
  const transfer = (amount: bigint, destination: string) => ({
    programId: "11111111111111111111111111111111", instructionName: "transfer", fields: {}, mode: "interpolated" as const,
    accounts: [], destination, amount, asset: "native"
  });
  const policy = { policyId: "p", programAllowlist: ["11111111111111111111111111111111"], destinationAllowlist: [], allowAnyDestination: true, maxAmountPerTransaction: { native: "100" }, maxAmountPerDay: { native: "1000000" } };
  const decide = (...amounts: bigint[]) => evaluatePolicy({ feePayer: "payer", instructions: amounts.map((a, i) => transfer(a, `dest${i}`)) }, policy);

  assert.equal(decide(100n).decision, "ALLOW", "exactly at the cap is allowed");
  assert.equal(decide(101n).decision, "NEEDS_REVIEW");
  const split = decide(60n, 60n);
  assert.equal(split.decision, "NEEDS_REVIEW", "60 + 60 against a cap of 100");
  assert.match(split.reasons.join(" "), /120 \(native\) exceeds the per-transaction limit of 100/);
  assert.equal(decide(50n, 50n).decision, "ALLOW", "a split that stays within the cap is fine");
  assert.equal(decide(60n, 60n, 60n).reasons.filter((r) => /per-transaction/.test(r)).length, 1, "one reason, not one per instruction");
});

test("an asset with no configured limit goes to review instead of being treated as unlimited", () => {
  const MINT = "Mint111111111111111111111111111111111111111";
  const tokenTransfer = (amount: bigint) => ({
    programId: PROGRAM, instructionName: "transferChecked", fields: {}, mode: "interpolated" as const,
    accounts: [], destination: VENDOR, amount, asset: MINT
  });
  const solOnly: Policy = { ...policy, maxAmountPerTransaction: { native: "100" }, maxAmountPerDay: { native: "100" } };
  const unconfigured = evaluatePolicy({ feePayer: "p", instructions: [tokenTransfer(5n)] }, solOnly);
  assert.equal(unconfigured.decision, "NEEDS_REVIEW");
  assert.match(unconfigured.reasons.join(" "), /no per-transaction limit for asset Mint/);
  assert.match(unconfigured.reasons.join(" "), /no daily limit for asset Mint/);

  const configured: Policy = { ...solOnly, maxAmountPerTransaction: { ...solOnly.maxAmountPerTransaction, [MINT]: "50" }, maxAmountPerDay: { ...solOnly.maxAmountPerDay, [MINT]: "500" } };
  assert.equal(evaluatePolicy({ feePayer: "p", instructions: [tokenTransfer(50n)] }, configured).decision, "ALLOW");
  assert.equal(evaluatePolicy({ feePayer: "p", instructions: [tokenTransfer(51n)] }, configured).decision, "NEEDS_REVIEW", "the mint's own cap applies, not the SOL cap");
});
