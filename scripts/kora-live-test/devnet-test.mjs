// One-off proof: a real agent transaction, decoded and policy-evaluated by
// AgentGuard's own code, then actually signed (as fee payer) and submitted
// to devnet by a real, locally running Kora instance. Not part of the
// permanent demo suite -- a standalone architecture proof.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { KoraClient } from "@solana/kora";
import { parseAndDecodeTransaction } from "../../dist/src/agent-integration/parse-transaction.js";
import { evaluatePolicy } from "../../dist/src/policy/evaluate.js";
import { buildDemoRegistry, buildDemoPolicy } from "../../dist/demo/policy.js";

const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const kora = new KoraClient({ rpcUrl: "http://localhost:8080" });

console.log("Fetching Kora's real fee-payer address...");
const { signer_address } = await kora.getPayerSigner();
const feePayer = new PublicKey(signer_address);
console.log("Kora fee payer:", feePayer.toBase58());

// Persistent, devnet-only throwaway keypair -- generated once and reused
// across runs, so a funded address doesn't go stranded every time this
// script runs. Path is overridable; defaults next to this script so it
// works out of the box for anyone who clones the repo.
const agentWalletPath = process.env.AGENT_WALLET_PATH ?? new URL("./devnet-agent-wallet.json", import.meta.url).pathname;
let agentWallet;
if (existsSync(agentWalletPath)) {
  const saved = JSON.parse(readFileSync(agentWalletPath, "utf8"));
  agentWallet = Keypair.fromSecretKey(bs58.decode(saved.privateKeyBase58));
} else {
  agentWallet = Keypair.generate();
  writeFileSync(
    agentWalletPath,
    JSON.stringify({ pubkey: agentWallet.publicKey.toBase58(), privateKeyBase58: bs58.encode(agentWallet.secretKey) }, null, 2)
  );
  console.log(`Generated a new devnet test wallet, saved to ${agentWalletPath}`);
}
const vendor = Keypair.generate();
console.log("Agent wallet (needs devnet SOL to send from):", agentWallet.publicKey.toBase58());
console.log("Vendor:", vendor.publicKey.toBase58());

const agentBalance = await connection.getBalance(agentWallet.publicKey);
console.log("Agent devnet balance:", agentBalance, "lamports");
if (agentBalance < 10000) {
  console.log("\nAgent wallet has no devnet SOL yet. Airdrop needed to this exact address before continuing:");
  console.log(agentWallet.publicKey.toBase58());
  process.exit(1);
}

const { blockhash } = await connection.getLatestBlockhash();
const transferIx = SystemProgram.transfer({
  fromPubkey: agentWallet.publicKey,
  toPubkey: vendor.publicKey,
  // Must clear Solana's rent-exempt minimum (~890,880 lamports) for a new
  // destination account to exist at all -- 1000 lamports (tried first)
  // correctly failed simulation with "insufficient funds for rent".
  lamports: 2_000_000
});

const message = new TransactionMessage({
  payerKey: feePayer, // Kora pays the network fee, not the agent
  recentBlockhash: blockhash,
  instructions: [transferIx]
}).compileToV0Message();

const tx = new VersionedTransaction(message);
tx.sign([agentWallet]); // agent signs for transfer authority; fee-payer slot stays open for Kora
const transactionBase64 = Buffer.from(tx.serialize()).toString("base64");

console.log("\n--- Running AgentGuard's real decode + policy evaluation ---");
const decoded = await parseAndDecodeTransaction(transactionBase64, buildDemoRegistry());
const evaluation = evaluatePolicy(decoded, buildDemoPolicy([vendor.publicKey.toBase58()]));
console.log("Decision:", evaluation.decision);
if (evaluation.reasons.length) console.log("Reasons:", evaluation.reasons.join("; "));

if (evaluation.decision !== "ALLOW") {
  console.log("\nNot ALLOWed, stopping before Kora (this is correct behavior, not an error).");
  process.exit(0);
}

console.log("\n--- ALLOWed. Forwarding to the real, locally running Kora instance ---");
const result = await kora.signAndSendTransaction({ transaction: transactionBase64 });
console.log("Kora signature:", result.signature);
console.log("Signer pubkey used:", result.signer_pubkey);

console.log("\n--- Confirming on real devnet ---");
const status = await connection.getSignatureStatuses([result.signature]);
console.log("On-chain status:", JSON.stringify(status.value[0]));
console.log(`\nExplorer: https://explorer.solana.com/tx/${result.signature}?cluster=devnet`);
