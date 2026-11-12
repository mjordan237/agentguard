import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";
import { AgentGuardClient, AgentGuardError } from "../src/client/index.js";

const SOL = 1_000_000_000;
const listen = (server: http.Server) => new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
  server.listen(0, () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) })));

async function setup(koraSigningFails = false) {
  const feePayer = Keypair.generate();
  const vendor = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const state = { signed: 0 };
  const kora = await listen(http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rpc = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      if (rpc.method === "getPayerSigner") return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signer_address: feePayer.publicKey.toBase58(), payment_address: feePayer.publicKey.toBase58() } }));
      if (koraSigningFails) return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", error: { code: -32000, message: "relayer down" } }));
      state.signed += 1;
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signature: `sig-${state.signed}`, signed_transaction: "x", signer_pubkey: feePayer.publicKey.toBase58() } }));
    });
  }));
  const customers = new CustomerStore();
  const reviewers = new ReviewerStore();
  const acme = customers.create("acme", 100_000);
  customers.setPolicy(acme.id, {
    policyId: "pay", programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [vendor.toBase58()],
    maxAmountPerTransaction: { native: String(1 * SOL) }, maxAmountPerDay: { native: String(100 * SOL) }
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const reviewer = reviewers.create("Alice", acme.id);
  const app = createServer(new Map(), buildDemoRegistry(), {
    baseUrl: "http://placeholder", reviewActionSecret: "s", customers, reviewers, rateLimit: { maxRequests: 100_000, windowMs: 60_000 },
    koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${kora.port}` }) }
  });
  const server = await listen(http.createServer(app));
  const baseUrl = `http://localhost:${server.port}`;
  const tx = (lamports: number, to = vendor) => Buffer.from(new VersionedTransaction(new TransactionMessage({
    payerKey: feePayer.publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: agent, toPubkey: to, lamports })]
  }).compileToV0Message()).serialize()).toString("base64");
  const act = (id: string, action: "approve" | "deny") => fetch(`${baseUrl}/review/${id}/${action}`, { method: "POST", redirect: "manual", headers: { "x-reviewer-token": reviewer.token } });
  return { baseUrl, apiKey, state, tx, act, vendor, close: async () => { await server.close(); await kora.close(); } };
}

test("client: an allowed payment is signed in one call", async () => {
  const t = await setup();
  try {
    const guard = new AgentGuardClient({ baseUrl: `${t.baseUrl}/`, apiKey: t.apiKey });
    const r = await guard.signWithApproval({ agentId: "bot", policyId: "pay", transactionBase64: t.tx(1000) });
    assert.equal(r.outcome, "signed");
    assert.equal(r.outcome === "signed" && r.reviewed, false);
    assert.equal(t.state.signed, 1);
    const preview = await guard.evaluate({ agentId: "bot", policyId: "pay", transactionBase64: t.tx(1000) });
    assert.equal(preview.decision, "ALLOW");
    assert.equal(t.state.signed, 1, "evaluate never signs");
  } finally { await t.close(); }
});

/** A fetch that notices when /gate-and-sign opens a review and has a "person" resolve it shortly afterwards. */
function withPerson(act: (id: string, action: "approve" | "deny") => Promise<Response>, action: "approve" | "deny" | "nobody", delayMs = 300): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await fetch(input, init);
    if (String(input).endsWith("/gate-and-sign") && action !== "nobody") {
      const body = (await response.clone().json().catch(() => undefined)) as { reviewId?: string; decision?: string } | undefined;
      if (body?.decision === "NEEDS_REVIEW" && body.reviewId) setTimeout(() => void act(body.reviewId!, action), delayMs);
    }
    return response;
  }) as typeof fetch;
}

test("client: a payment that needs a person waits, then signs once they approve, and the approval is single use", async () => {
  const t = await setup();
  try {
    const guard = new AgentGuardClient({ baseUrl: t.baseUrl, apiKey: t.apiKey, fetchImpl: withPerson(t.act, "approve") });
    const request = { agentId: "bot", policyId: "pay", transactionBase64: t.tx(2 * SOL) };
    const r = await guard.signWithApproval(request, { pollMs: 250, timeoutMs: 30_000 });
    assert.equal(r.outcome, "signed");
    assert.equal(r.outcome === "signed" && r.reviewed, true);
    assert.equal(t.state.signed, 1);
    const reviewId = r.outcome === "signed" ? (r.result.signedViaReview as string) : "";
    assert.ok(reviewId, "the result says which approval was spent");
    // Spending the same approval again must fail, and nothing more is signed.
    await assert.rejects(guard.gateAndSign({ ...request, reviewId }), (e: unknown) => e instanceof AgentGuardError && e.code === "REVIEW_ALREADY_USED" && e.status === 409);
    assert.equal(t.state.signed, 1);
    assert.equal((await guard.getReview(reviewId)).used, true);
  } finally { await t.close(); }
});

test("client: a denied review ends the loop and signs nothing", async () => {
  const t = await setup();
  try {
    const guard = new AgentGuardClient({ baseUrl: t.baseUrl, apiKey: t.apiKey, fetchImpl: withPerson(t.act, "deny") });
    const r = await guard.signWithApproval({ agentId: "bot", policyId: "pay", transactionBase64: t.tx(2 * SOL) }, { pollMs: 250, timeoutMs: 30_000 });
    assert.equal(r.outcome, "denied");
    assert.equal(r.outcome === "denied" && r.review.status, "DENIED");
    assert.equal(t.state.signed, 0);
  } finally { await t.close(); }
});

test("client: nobody answering ends in a timeout that names the review, and the review stays pending", async () => {
  const t = await setup();
  try {
    const guard = new AgentGuardClient({ baseUrl: t.baseUrl, apiKey: t.apiKey });
    const started = Date.now();
    const r = await guard.signWithApproval({ agentId: "bot", policyId: "pay", transactionBase64: t.tx(2 * SOL) }, { pollMs: 250, timeoutMs: 900 });
    assert.equal(r.outcome, "timeout");
    assert.ok(Date.now() - started < 5_000, "it gave up instead of waiting forever");
    if (r.outcome === "timeout") {
      assert.match(r.reviewUrl ?? "", /\/review\//);
      assert.equal((await guard.getReview(r.reviewId)).status, "PENDING");
    }
    assert.equal(t.state.signed, 0);
  } finally { await t.close(); }
});

test("client: a payment to a stranger is held for review and never signed without approval", async () => {
  const t = await setup();
  try {
    const guard = new AgentGuardClient({ baseUrl: t.baseUrl, apiKey: t.apiKey });
    const held = await guard.gateAndSign({ agentId: "bot", policyId: "pay", transactionBase64: t.tx(1000, Keypair.generate().publicKey) });
    assert.equal(held.decision, "NEEDS_REVIEW");
    assert.ok(held.reviewId && held.reviewUrl);
    assert.equal(t.state.signed, 0);
  } finally { await t.close(); }
});

test("client: errors carry the status and code, never the API key, and a relayer failure is flagged as unknown", async () => {
  const t = await setup();
  const failing = await setup(true);
  try {
    const wrong = new AgentGuardClient({ baseUrl: t.baseUrl, apiKey: "agk_not_a_real_key_1234567890" });
    await assert.rejects(wrong.evaluate({ agentId: "a", policyId: "pay", transactionBase64: t.tx(1) }), (e: unknown) => {
      assert.ok(e instanceof AgentGuardError);
      assert.equal(e.status, 401);
      assert.equal(e.code, "INVALID_API_KEY");
      assert.ok(!JSON.stringify(e.body).includes("agk_not_a_real_key") && !e.message.includes("agk_not_a_real_key"), "the key is not echoed");
      return true;
    });
    const guard = new AgentGuardClient({ baseUrl: t.baseUrl, apiKey: t.apiKey });
    await assert.rejects(guard.evaluate({ agentId: "a", policyId: "nope", transactionBase64: t.tx(1) }), (e: unknown) => e instanceof AgentGuardError && e.status === 404 && e.code === "POLICY_NOT_FOUND");
    await assert.rejects(guard.getReview("does-not-exist"), (e: unknown) => e instanceof AgentGuardError && e.status === 404);

    const flaky = new AgentGuardClient({ baseUrl: failing.baseUrl, apiKey: failing.apiKey });
    await assert.rejects(flaky.gateAndSign({ agentId: "a", policyId: "pay", transactionBase64: failing.tx(1000) }), (e: unknown) => e instanceof AgentGuardError && e.status === 502 && e.outcomeUnknown === true);
  } finally { await t.close(); await failing.close(); }
});

test("client: it never retries by itself, and bad settings and replies are errors", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return new Response(JSON.stringify({ error: "KORA_SIGNING_FAILED", outcome: "UNKNOWN", message: "x" }), { status: 502 }); }) as unknown as typeof fetch;
  const guard = new AgentGuardClient({ baseUrl: "https://guard.example/api/", fetchImpl });
  await assert.rejects(guard.gateAndSign({ agentId: "a", policyId: "p", transactionBase64: "AA==" }), AgentGuardError);
  assert.equal(calls, 1, "a 502 with an unknown outcome is not retried");

  let seen = "";
  const spy = (async (url: string) => { seen = url; return new Response("not json", { status: 200 }); }) as unknown as typeof fetch;
  await assert.rejects(new AgentGuardClient({ baseUrl: "https://guard.example/api/", fetchImpl: spy }).getReview("a/b"), /not JSON/);
  assert.equal(seen, "https://guard.example/api/reviews/a%2Fb", "path prefix kept, trailing slash dropped, id encoded");

  for (const bad of ["", "not a url", "ftp://x", "javascript:alert(1)"]) assert.throws(() => new AgentGuardClient({ baseUrl: bad }), /baseUrl/);
});
