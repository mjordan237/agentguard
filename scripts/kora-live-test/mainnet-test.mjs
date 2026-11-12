// Manual mainnet signing test. This script transfers real SOL.
// Review the amount, destination and signer configuration before running it.
// Each step prints its intended action before proceeding.
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { KoraClient } from "@solana/kora";
import { parseAndDecodeTransaction } from "../../dist/src/agent-integration/parse-transaction.js";
import { evaluatePolicy } from "../../dist/src/policy/evaluate.js";
import { buildDemoRegistry, buildDemoPolicy } from "../../dist/demo/policy.js";

// Set AGENT_KEY_PATH to the local file containing the test wallet's private key.
// Keep that file out of version control and do not paste its contents into logs.
const AGENT_KEY_PATH = process.env.AGENT_KEY_PATH;
if (!AGENT_KEY_PATH) {
  console.error("Set AGENT_KEY_PATH to a protected local key file before running this manual mainnet test.");
  process.exit(1);
}

// Deliberately tiny: this is a wiring proof, not a real payment. 0.01 SOL.
const TEST_AMOUNT_LAMPORTS = 10_000_000;

const connection = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const kora = new KoraClient({ rpcUrl: "http://localhost:8080" });

console.log("Fetching Kora's real mainnet fee-payer address...");
const { signer_address } = await kora.getPayerSigner();
const feePayer = new PublicKey(signer_address);
console.log("Kora fee payer:", feePayer.toBase58());

console.log(`\nLoading your agent wallet's private key from: ${AGENT_KEY_PATH}`);
let agentWallet;
try {
  const raw = readFileSync(AGENT_KEY_PATH, "utf8").trim();
  agentWallet = Keypair.fromSecretKey(bs58.decode(raw));
} catch (error) {
  console.error(`\nCouldn't load a key from ${AGENT_KEY_PATH}: ${error.message}`);
  console.error("Provide the key through a protected local file; do not paste it into a shell command.");
  process.exit(1);
}
console.log("Agent wallet loaded:", agentWallet.publicKey.toBase58());

// The transfer recipient is the configured Kora fee payer. Verify ownership before running.
const vendor = feePayer;

const agentBalance = await connection.getBalance(agentWallet.publicKey);
console.log(`\nAgent wallet real mainnet balance: ${agentBalance} lamports (${agentBalance / 1e9} SOL)`);
if (agentBalance < TEST_AMOUNT_LAMPORTS + 5000) {
  console.error(`\nNot enough SOL in the agent wallet for a ${TEST_AMOUNT_LAMPORTS} lamport test transfer plus fees. Stopping.`);
  process.exit(1);
}

const feePayerBalance = await connection.getBalance(feePayer);
console.log(`Kora fee-payer real mainnet balance: ${feePayerBalance} lamports (${feePayerBalance / 1e9} SOL)`);
if (feePayerBalance < 5000) {
  console.error("\nKora's fee-payer wallet has no SOL to cover the network fee. Fund it first, then rerun.");
  process.exit(1);
}

console.log(`\n--- About to transfer ${TEST_AMOUNT_LAMPORTS} lamports (${TEST_AMOUNT_LAMPORTS / 1e9} SOL, real money) ---`);
console.log(`From: ${agentWallet.publicKey.toBase58()}`);
console.log(`To:   ${vendor.toBase58()} (configured Kora fee-payer address)`);
console.log("Waiting 5 seconds before proceeding. Ctrl+C now to cancel.");
await new Promise((resolve) => setTimeout(resolve, 5000));

const { blockhash } = await connection.getLatestBlockhash();
const transferIx = SystemProgram.transfer({
  fromPubkey: agentWallet.publicKey,
  toPubkey: vendor,
  lamports: TEST_AMOUNT_LAMPORTS
});

const message = new TransactionMessage({
  payerKey: feePayer,
  recentBlockhash: blockhash,
  instructions: [transferIx]
}).compileToV0Message();

const tx = new VersionedTransaction(message);
tx.sign([agentWallet]);
const transactionBase64 = Buffer.from(tx.serialize()).toString("base64");

console.log("\n--- Running AgentGuard's real decode + policy evaluation ---");
const decoded = await parseAndDecodeTransaction(transactionBase64, buildDemoRegistry());
const evaluation = evaluatePolicy(decoded, buildDemoPolicy([vendor.toBase58()]));
console.log("Decision:", evaluation.decision);
if (evaluation.reasons.length) console.log("Reasons:", evaluation.reasons.join("; "));

if (evaluation.decision !== "ALLOW") {
  console.log("\nNot ALLOWed, stopping before Kora (correct behavior, no funds moved).");
  process.exit(0);
}

console.log("\n--- ALLOWed. Forwarding to the real, locally running mainnet Kora instance ---");
const result = await kora.signAndSendTransaction({ transaction: transactionBase64 });
console.log("Signature:", result.signature);
console.log("Signer pubkey used:", result.signer_pubkey);

console.log("\n--- Confirming on real mainnet ---");
const status = await connection.getSignatureStatuses([result.signature]);
console.log("On-chain status:", JSON.stringify(status.value[0]));
console.log(`\nExplorer: https://explorer.solana.com/tx/${result.signature}`);
