/**
 * Local transaction review with an optional model-generated explanation.
 * Leaves the server running for an authenticated browser review.
 *
 * Real run:   NEBIUS_API_KEY=... NEBIUS_MODEL=... node dist/demo/nemotron-review-demo.js
 * Rehearsal:  node dist/demo/nemotron-review-demo.js --stub
 *
 * --stub starts a local fake Token Factory so the page layout can be
 * rehearsed without a key. Its note is labeled with the model id
 * "local-stub-not-nemotron" on the page.
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { createServer } from "../src/api/server.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { DEFAULT_NEBIUS_BASE_URL, type ExplainerConfig } from "../src/analysis/nemotron-explainer.js";
import { buildDemoRegistry, buildDemoPolicy } from "./policy.js";

const reviewers = new ReviewerStore();
const reviewer = reviewers.create("Local demo reviewer");
const useStub = process.argv.includes("--stub");

function buildAdversarialTransaction(vendor: Keypair): string {
  const agentWallet = Keypair.generate();
  const attackerProgram = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: agentWallet.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      SystemProgram.transfer({ fromPubkey: agentWallet.publicKey, toPubkey: vendor.publicKey, lamports: 250_000_000 }),
      SystemProgram.assign({ accountPubkey: agentWallet.publicKey, programId: attackerProgram.publicKey })
    ]
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

function startStubTokenFactory(): Promise<string> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "STUB TEXT, not from a model. Sends 0.25 SOL to a vendor, then reassigns the paying wallet to another program.",
            risks: ["The second instruction changes who controls the wallet and moves no funds."]
          })
        }
      }]
    }));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(`http://localhost:${(server.address() as AddressInfo).port}/v1`)));
}

async function resolveExplainer(): Promise<ExplainerConfig> {
  if (useStub) {
    return { apiKey: "stub", model: "local-stub-not-nemotron", baseUrl: await startStubTokenFactory() };
  }
  const apiKey = process.env.NEBIUS_API_KEY;
  const model = process.env.NEBIUS_MODEL;
  if (!apiKey || !model) {
    console.error("Set NEBIUS_API_KEY and NEBIUS_MODEL (list ids with scripts/list-nebius-models.mjs), or pass --stub to rehearse.");
    process.exit(1);
  }
  return { apiKey, model, baseUrl: process.env.NEBIUS_BASE_URL ?? DEFAULT_NEBIUS_BASE_URL, timeoutMs: 20_000 };
}

const explainer = await resolveExplainer();
const vendor = Keypair.generate();
const server = http.createServer(
  createServer(new Map([["demo", buildDemoPolicy([vendor.publicKey.toBase58()])]]), buildDemoRegistry(), {
    baseUrl: "http://localhost:8788",
    reviewers,
    requireReviewers: true,
    explainer
  })
);
await new Promise<void>((resolve) => server.listen(8788, resolve));

console.log(`=== Adversarial payment through AgentGuard, Nemotron assist ${useStub ? "(STUB, rehearsal only)" : `(model ${explainer.model})`} ===`);
const started = Date.now();
const response = await fetch("http://localhost:8788/evaluate", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ agentId: "property-agent", policyId: "demo", transactionBase64: buildAdversarialTransaction(vendor) })
});
const result = (await response.json()) as { decision: string; reasons: string[]; reviewUrl: string; reviewId: string };
console.log(`Decision: ${result.decision} (returned in ${Date.now() - started} ms, before the model was waited on)`);
console.log(`Reasons:  ${result.reasons.join(" ")}`);
console.log(`Review:   ${result.reviewUrl}`);

let noteSeenAfterMs: number | undefined;
for (let waited = 0; waited < 30_000; waited += 500) {
  const detail = await fetch(`http://localhost:8788/operator/api/reviews/${result.reviewId}`, {
    headers: { "X-Reviewer-Token": reviewer.token }
  });
  const review = await detail.json() as { advisoryExplanation?: unknown };
  if (detail.ok && review.advisoryExplanation) {
    noteSeenAfterMs = Date.now() - started;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.log(noteSeenAfterMs === undefined
  ? "No AI note appeared within 30s (the review page still works without it)."
  : `AI note attached after ${noteSeenAfterMs} ms.`);
console.log(`Temporary reviewer token for this local demo: ${reviewer.token}`);
console.log("Server stays up on :8788 for the browser. Ctrl+C to stop.");
