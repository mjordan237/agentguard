/**
 * Demo run 4: an approved vendor, a cleanly-decoded transfer, but the
 * amount exceeds the per-transaction spend cap. Proves the spend-limit
 * check independently of the destination-allowlist check (run 3) and
 * the raw_dump check (run 2).
 *
 * Expect NEEDS_REVIEW purely from the per-transaction limit.
 */
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import { buildDemoRegistry, buildDemoPolicy } from "./policy.js";

const agentWallet = Keypair.generate();
const vendor = Keypair.generate();

const oneSolInLamports = 1_000_000_000;
const transferInstruction = SystemProgram.transfer({
  fromPubkey: agentWallet.publicKey,
  toPubkey: vendor.publicKey,
  lamports: oneSolInLamports * 3 // 3 SOL -- well over the default 1 SOL per-transaction cap
});

const message = new TransactionMessage({
  payerKey: agentWallet.publicKey,
  recentBlockhash: PublicKey.default.toBase58(),
  instructions: [transferInstruction]
}).compileToV0Message();

const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

console.log("=== Approved vendor, amount over the per-transaction limit ===");
console.log(`Agent wallet: ${agentWallet.publicKey.toBase58()}`);
console.log(`Vendor:       ${vendor.publicKey.toBase58()} (approved)`);
console.log();

const decoded = await parseAndDecodeTransaction(transactionBase64, buildDemoRegistry());
const evaluation = evaluatePolicy(decoded, buildDemoPolicy([vendor.publicKey.toBase58()], String(oneSolInLamports)));

console.log("Decoded intent:");
for (const instruction of decoded.instructions) {
  console.log(`  ${instruction.programId} :: ${instruction.instructionName} (${instruction.mode})`);
  console.log(`    ${JSON.stringify(instruction.fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}
console.log();
console.log(`Decision: ${evaluation.decision}`);
if (evaluation.reasons.length > 0) console.log(`Reasons: ${evaluation.reasons.join("; ")}`);
