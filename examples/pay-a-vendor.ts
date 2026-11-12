// Run after `npm run build`:  AGENTGUARD_URL=... AGENTGUARD_API_KEY=agk_... node dist/examples/pay-a-vendor.js
//
// An agent builds its transaction, hands it to AgentGuard, and signs only what comes back allowed or approved.
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { AgentGuardClient, AgentGuardError } from "../src/client/index.js";

const baseUrl = process.env.AGENTGUARD_URL;
if (!baseUrl) throw new Error("Set AGENTGUARD_URL, for example http://localhost:8787");
const guard = new AgentGuardClient({ baseUrl, apiKey: process.env.AGENTGUARD_API_KEY });

// In a real agent the fee payer is your Kora signer's address and the blockhash is fresh from your RPC.
const feePayer = new PublicKey(process.env.FEE_PAYER ?? Keypair.generate().publicKey);
const vendor = new PublicKey(process.env.VENDOR ?? Keypair.generate().publicKey);
const agent = Keypair.generate().publicKey;
const message = new TransactionMessage({
  payerKey: feePayer,
  recentBlockhash: PublicKey.default.toBase58(),
  instructions: [SystemProgram.transfer({ fromPubkey: agent, toPubkey: vendor, lamports: 2_000_000 })]
}).compileToV0Message();
const transactionBase64 = Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");

try {
  const result = await guard.signWithApproval(
    { agentId: "invoice-bot", policyId: process.env.POLICY_ID ?? "demo", transactionBase64 },
    { timeoutMs: 120_000 }
  );
  switch (result.outcome) {
    case "signed": console.log(result.reviewed ? "Approved by a person, then signed:" : "Allowed and signed:", result.result.kora); break;
    case "denied": console.log("A person denied it:", result.review.reasons); break;
    case "expired": console.log("The review expired before anyone decided."); break;
    case "timeout": console.log(`Still waiting for a person. Review: ${result.reviewUrl}`); break;
  }
} catch (error) {
  if (error instanceof AgentGuardError && error.outcomeUnknown) {
    // Do not resubmit blindly: the transaction may already be on chain. Check its status first.
    console.error("Signing outcome unknown:", error.message);
  } else throw error;
}
