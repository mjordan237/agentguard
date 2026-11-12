/**
 * `npm run quickstart`: starts the real server with a demo customer and a stand-in relayer, then walks through
 * what a developer sees first: a payment that is allowed and signed, one held for a hidden instruction, and the
 * review step that releases it. Nothing leaves your machine; no keys, no network, no money.
 *
 *   npm run quickstart                 serve, and wait for you to approve the held payment in a browser
 *   npm run quickstart -- --auto-approve --exit    do the approval for you and exit (a smoke test)
 * PORT sets the port (default 8787).
 */
import { startDemoServer } from "./demo-server.js";
import { AgentGuardClient } from "../src/client/index.js";

const autoApprove = process.argv.includes("--auto-approve");
const exitWhenDone = process.argv.includes("--exit");
const started = Date.now();
const secs = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error(`PORT must be a whole number from 0 to 65535, got "${process.env.PORT}".`); process.exit(1); }
const demo = await startDemoServer(port).catch((error: NodeJS.ErrnoException) => {
  console.error(error.code === "EADDRINUSE" ? `Port ${port} is already in use. Pick another one, for example: PORT=8790 npm run quickstart` : `Could not start: ${error.message}`);
  process.exit(1);
});
const { info } = demo;
const guard = new AgentGuardClient({ baseUrl: info.baseUrl, apiKey: info.apiKey });
const request = (transactionBase64: string) => ({ agentId: info.agentId, policyId: info.policyId, transactionBase64 });

console.log(`AgentGuard is running at ${info.baseUrl}   (demo customer "Acme Robotics", stand-in relayer)\n`);
console.log("1. A normal payment: 0.25 SOL to an approved vendor");
const ok = await guard.gateAndSign(request(info.transactions.legitimate));
console.log(`   ${ok.decision === "ALLOW" ? "ALLOWED and signed" : "unexpected: " + ok.decision}   [${secs()}]`);
console.log(`   relayer signature: ${(ok.kora as { signature?: string } | undefined)?.signature ?? "(none)"}\n`);

console.log("2. The same payment with a second, hidden instruction");
const held = await guard.gateAndSign(request(info.transactions.hidden));
console.log(`   ${held.decision === "NEEDS_REVIEW" ? "HELD for a person" : "unexpected: " + held.decision}`);
for (const reason of held.reasons) console.log(`   reason: ${reason}`);
if (!held.reviewId) throw new Error("expected a review to be opened");

console.log("\n3. A payment to an address nobody approved, and one over the limit");
for (const [label, tx] of [["stranger", info.transactions.stranger], ["over the limit", info.transactions.overLimit]] as const) {
  const r = await guard.evaluate(request(tx));
  console.log(`   ${label}: ${r.decision}${r.reasons[0] ? ` (${r.reasons[0]})` : ""}`);
}

console.log("\n4. The review step");
if (autoApprove) {
  const res = await fetch(`${info.baseUrl}/review/${held.reviewId}/approve`, { method: "POST", redirect: "manual", headers: { "x-reviewer-token": info.reviewerToken } });
  console.log(`   approved by the demo reviewer (HTTP ${res.status})`);
} else {
  console.log(`   Open  ${held.reviewUrl}`);
  console.log(`   Reviewer token (paste it into the page):  ${info.reviewerToken}`);
  console.log("   Waiting for you to click Approve or Deny (10 minutes)...");
  const review = await guard.waitForReview(held.reviewId, { timeoutMs: 10 * 60_000 });
  if (!review || review.status !== "APPROVED") {
    console.log(`   ${review ? `review ended as ${review.status}` : "timed out"}; nothing was signed.`);
    await demo.close();
    process.exit(0);
  }
}
const released = await guard.gateAndSign({ ...request(info.transactions.hidden), reviewId: held.reviewId });
console.log(`   the agent retries and is signed: ${(released.kora as { signature?: string } | undefined)?.signature ?? "(none)"}   [${secs()}]`);
try {
  await guard.gateAndSign({ ...request(info.transactions.hidden), reviewId: held.reviewId });
  console.log("   unexpected: the same approval worked twice");
} catch (error) {
  console.log(`   the same approval used again is refused: ${(error as Error).message}`);
}

console.log(`\nDone in ${secs()}. Next: write your own policy and check it offline with\n  node dist/src/cli/check.js --policy my-policy.json --tx <base64>`);
if (exitWhenDone) { await demo.close(); process.exit(0); }
console.log(`\nStill serving. Try the API yourself:\n  curl -s ${info.baseUrl}/evaluate -H "authorization: Bearer ${info.apiKey}" -H "content-type: application/json" \\\n    -d '${JSON.stringify(request(info.transactions.legitimate))}'\n\nCtrl-C to stop.`);
