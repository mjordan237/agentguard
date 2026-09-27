/**
 * Demo run 3: a transaction that decodes perfectly cleanly -- no hidden
 * instruction, no raw_dump, nothing a discriminator check would catch --
 * but pays a destination that was never approved as a vendor. This is
 * the case demo run 2 does NOT cover: a fully legible, fully verified
 * instruction that's still the wrong thing to auto-approve.
 *
 * Expect NEEDS_REVIEW purely from the destination-allowlist check.
 */
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import { buildDemoRegistry, buildDemoPolicy } from "./policy.js";

const agentWallet = Keypair.generate();
const approvedVendor = Keypair.generate();
const unapprovedRecipient = Keypair.generate(); // e.g. an address a prompt-injected agent was tricked into paying instead

const transferInstruction = SystemProgram.transfer({
  fromPubkey: agentWallet.publicKey,
  toPubkey: unapprovedRecipient.publicKey,
  lamports: 250_000_000
});

const message = new TransactionMessage({
  payerKey: agentWallet.publicKey,
  recentBlockhash: PublicKey.default.toBase58(),
  instructions: [transferInstruction]
}).compileToV0Message();

const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

console.log("=== Cleanly-decoded payment to an unapproved destination ===");
console.log(`Agent wallet:         ${agentWallet.publicKey.toBase58()}`);
console.log(`Approved vendor:      ${approvedVendor.publicKey.toBase58()} (not used in this transaction)`);
console.log(`Actual recipient:     ${unapprovedRecipient.publicKey.toBase58()}`);
console.log();

const decoded = await parseAndDecodeTransaction(transactionBase64, buildDemoRegistry());
// Policy only approves approvedVendor -- unapprovedRecipient is not on it.
const evaluation = evaluatePolicy(decoded, buildDemoPolicy([approvedVendor.publicKey.toBase58()]));

console.log("Decoded intent:");
for (const instruction of decoded.instructions) {
  console.log(`  ${instruction.programId} :: ${instruction.instructionName} (${instruction.mode})`);
  console.log(`    ${JSON.stringify(instruction.fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
}
console.log();
console.log(`Decision: ${evaluation.decision}`);
if (evaluation.reasons.length > 0) console.log(`Reasons: ${evaluation.reasons.join("; ")}`);
