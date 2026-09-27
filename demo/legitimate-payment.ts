/**
 * Demo run 1: the property-maintenance agent pays a vendor for completed
 * work. One instruction, the one thing the policy allows. Expect ALLOW.
 */
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import { buildDemoRegistry, buildDemoPolicy } from "./policy.js";

const agentWallet = Keypair.generate();
const vendor = Keypair.generate();

const transferInstruction = SystemProgram.transfer({
  fromPubkey: agentWallet.publicKey,
  toPubkey: vendor.publicKey,
  lamports: 250_000_000 // 0.25 SOL, "invoice payment for completed repair"
});

const message = new TransactionMessage({
  payerKey: agentWallet.publicKey,
  recentBlockhash: PublicKey.default.toBase58(),
  instructions: [transferInstruction]
}).compileToV0Message();

const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

console.log("=== Legitimate vendor payment ===");
console.log(`Agent wallet: ${agentWallet.publicKey.toBase58()}`);
console.log(`Vendor:       ${vendor.publicKey.toBase58()}`);
console.log();

const decoded = await parseAndDecodeTransaction(transactionBase64, buildDemoRegistry());
const evaluation = evaluatePolicy(decoded, buildDemoPolicy([vendor.publicKey.toBase58()]));

console.log("Decoded intent:");
for (const instruction of decoded.instructions) {
  console.log(`  ${instruction.programId} :: ${instruction.instructionName} (${instruction.mode})`);
  console.log(`    ${JSON.stringify(instruction.fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}
console.log();
console.log(`Decision: ${evaluation.decision}`);
if (evaluation.reasons.length > 0) console.log(`Reasons: ${evaluation.reasons.join("; ")}`);
