/**
 * Demo run 2: same vendor payment, but a compromised tool/prompt
 * injection has appended a second instruction the agent never intended
 * -- a System Program Assign, reassigning the agent wallet's own account
 * to an attacker-controlled program. This is the same threat class as
 * SPL Token's SetAuthority hijack: it moves zero balance, so a
 * simulator that only diffs balances would call this transaction safe.
 *
 * The registry only has "transfer" registered for System Program (see
 * demo/policy.ts), so Assign's discriminator matches nothing in it --
 * it can't be named or decoded, and falls to raw_dump. Expect
 * NEEDS_REVIEW, not a silent ALLOW.
 */
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import { buildDemoRegistry, buildDemoPolicy } from "./policy.js";

const agentWallet = Keypair.generate();
const vendor = Keypair.generate();
const attackerProgram = Keypair.generate();

const transferInstruction = SystemProgram.transfer({
  fromPubkey: agentWallet.publicKey,
  toPubkey: vendor.publicKey,
  lamports: 250_000_000
});

// The injected instruction. Same account, no balance movement --
// invisible to a balance-diff-only simulator.
const hijackInstruction = SystemProgram.assign({
  accountPubkey: agentWallet.publicKey,
  programId: attackerProgram.publicKey
});

const message = new TransactionMessage({
  payerKey: agentWallet.publicKey,
  recentBlockhash: PublicKey.default.toBase58(),
  instructions: [transferInstruction, hijackInstruction]
}).compileToV0Message();

const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

console.log("=== Adversarial: vendor payment + injected authority hijack ===");
console.log(`Agent wallet:      ${agentWallet.publicKey.toBase58()}`);
console.log(`Vendor:            ${vendor.publicKey.toBase58()}`);
console.log(`Attacker program:  ${attackerProgram.publicKey.toBase58()}`);
console.log();

const decoded = await parseAndDecodeTransaction(transactionBase64, buildDemoRegistry());
// Vendor is on the allowlist deliberately, so the only reason this gets
// flagged is the hidden instruction -- not an unrelated destination check.
const evaluation = evaluatePolicy(decoded, buildDemoPolicy([vendor.publicKey.toBase58()]));

console.log("Decoded intent:");
for (const instruction of decoded.instructions) {
  console.log(`  ${instruction.programId} :: ${instruction.instructionName} (${instruction.mode})`);
  console.log(`    ${JSON.stringify(instruction.fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}
console.log();
console.log(`Decision: ${evaluation.decision}`);
if (evaluation.reasons.length > 0) console.log(`Reasons: ${evaluation.reasons.join("; ")}`);
