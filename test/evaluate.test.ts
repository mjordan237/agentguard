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
  destinationAllowlist: [],
  maxAmountPerTransaction: {},
  maxAmountPerDay: {}
};

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
  const result = evaluatePolicy(decoded, policy);
  assert.equal(result.decision, "ALLOW");
});

test("allows a payment to a destination on the allowlist", () => {
  const restrictedPolicy: Policy = { ...policy, destinationAllowlist: [VENDOR] };
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
  const limitedPolicy: Policy = { ...policy, maxAmountPerTransaction: { native: "1000" } };
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
  const limitedPolicy: Policy = { ...policy, maxAmountPerDay: { native: "1000" } };
  const decoded: DecodedTransactionSummary = {
    feePayer: "fee-payer",
    instructions: [transferInstruction({ amount: 200n, asset: "native" })]
  };
  const result = evaluatePolicy(decoded, limitedPolicy, { native: 700n }); // 700 + 200 = 900, under 1000
  assert.equal(result.decision, "ALLOW");
});
