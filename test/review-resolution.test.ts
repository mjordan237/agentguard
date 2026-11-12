import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createServer, type ServerConfig } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { PendingReviewStore } from "../src/escalation/pending-store.js";
import { APP_SCRIPT } from "../src/escalation/operator-queue-page.js";
import type { AuditLog } from "../src/observability/audit-log.js";
import type { PolicyEvaluation } from "../src/policy/types.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";
import { readReview } from "./review-detail-helper.js";

function escalatingTx(): string {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1000 }),
      SystemProgram.assign({ accountPubkey: payer.publicKey, programId: Keypair.generate().publicKey })
    ]
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

/** Two customers, a reviewer for Acme, two operator reviewers, and an audit log that counts resolution events. */
async function world(options: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-resolution-"));
  const path = join(dir, "db.sqlite");
  const customers = new CustomerStore({ persistencePath: path });
  const reviewers = new ReviewerStore({ persistencePath: path });
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, { policyId: "acme-pay", programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [], allowAnyDestination: true, maxAmountPerTransaction: { native: "1000000000" }, maxAmountPerDay: { native: "5000000000" } });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const alice = reviewers.create("Alice", acme.id).token;
  const bob = reviewers.create("Bob").token;
  // Same display name as Bob: names are not identities.
  const otherBob = reviewers.create("Bob").token;
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const app = createServer(new Map([["demo", buildDemoPolicy()]]), buildDemoRegistry(), {
    baseUrl: "http://placeholder", persistencePath: path, customers, reviewers, rateLimit: { maxRequests: 10_000, windowMs: 60_000 },
    auditLog: { append: (_c: string | undefined, type: string, data: Record<string, unknown>) => { events.push({ type, data }); }, list: () => [], verify: () => ({ ok: true }) } as unknown as AuditLog,
    ...options
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, path, alice, bob, otherBob, events,
    escalate: async () => ((await (await fetch(`${base}/evaluate`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ agentId: "a", policyId: "acme-pay", transactionBase64: escalatingTx() }) })).json()) as { reviewId: string }).reviewId,
    /** What the review page sends: the token in a header, asking for a JSON answer. */
    decide: async (id: string, action: "approve" | "deny", token: string) => {
      const response = await fetch(`${base}/review/${id}/${action}`, { method: "POST", redirect: "manual", headers: { "x-reviewer-token": token, accept: "application/json" } });
      return { status: response.status, body: (await response.json()) as { outcome: string; status: string; id: string } };
    },
    resolutions: (id: string) => events.filter((e) => e.type === "review_resolved" && e.data.reviewId === id).length,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); rmSync(dir, { recursive: true, force: true }); }
  };
}

for (const action of ["approve", "deny"] as const) {
  const final = action === "approve" ? "APPROVED" : "DENIED";
  test(`${action}: the first reviewer's request applies it; a later ${action} by another reviewer is told it was already decided`, async () => {
    const w = await world();
    try {
      const id = await w.escalate();
      const first = await w.decide(id, action, w.alice);
      assert.deepEqual([first.status, first.body.outcome, first.body.status], [200, "applied", final]);
      const before = await readReview(w.base, id, { token: w.bob });
      const second = await w.decide(id, action, w.bob);
      assert.deepEqual([second.status, second.body.outcome, second.body.status], [409, "already_decided", final], "same final status, but not this request's doing");
      const after = await readReview(w.base, id, { token: w.bob });
      assert.deepEqual(after.resolvedBy, { kind: "reviewer", name: "Alice" }, "the original resolver is kept");
      assert.equal(after.resolvedAt, before.resolvedAt, "and so is the original time");
      assert.equal(w.resolutions(id), 1, "one resolution event, from the request that applied it");
    } finally { await w.close(); }
  });
}

test("opposing decisions: the later one changes nothing and is told so", async () => {
  const w = await world();
  try {
    const id = await w.escalate();
    assert.equal((await w.decide(id, "approve", w.alice)).body.outcome, "applied");
    const denied = await w.decide(id, "deny", w.bob);
    assert.deepEqual([denied.status, denied.body.outcome, denied.body.status], [409, "already_decided", "APPROVED"]);
    assert.equal((await readReview(w.base, id, { token: w.bob })).status, "APPROVED");
    assert.equal(w.resolutions(id), 1);
  } finally { await w.close(); }
});

test("the same reviewer repeating a decision is told the second request changed nothing", async () => {
  const w = await world();
  try {
    const id = await w.escalate();
    assert.equal((await w.decide(id, "approve", w.alice)).body.outcome, "applied");
    assert.equal((await w.decide(id, "approve", w.alice)).body.outcome, "already_decided", "not \"applied\" again, even for the same person");
    assert.equal(w.resolutions(id), 1);
  } finally { await w.close(); }
});

test("two reviewers with the same display name are still told apart: only the request that applied it is credited", async () => {
  const w = await world();
  try {
    const id = await w.escalate();
    assert.equal((await w.decide(id, "approve", w.bob)).body.outcome, "applied");
    assert.equal((await w.decide(id, "approve", w.otherBob)).body.outcome, "already_decided");
  } finally { await w.close(); }
});

test("an expired review answers expired, as JSON for the page and as before for form clients", async () => {
  const w = await world({ reviewExpiryMs: 1 });
  try {
    const id = await w.escalate();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const json = await w.decide(id, "approve", w.alice);
    assert.deepEqual([json.status, json.body.outcome, json.body.status], [410, "expired", "EXPIRED"]);
    const form = await fetch(`${w.base}/review/${id}/approve`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: w.alice }).toString() });
    assert.equal(form.status, 410);
    assert.match(await form.text(), /expired/);
    assert.equal(w.resolutions(id), 0);
  } finally { await w.close(); }
});

test("legacy form and header clients keep the redirect, whether or not their request applied the decision", async () => {
  const w = await world();
  try {
    const id = await w.escalate();
    const form = (token: string) => fetch(`${w.base}/review/${id}/approve`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, body: new URLSearchParams({ token }).toString() });
    const applied = await form(w.alice);
    assert.deepEqual([applied.status, applied.headers.get("location")], [302, `/review/${id}`]);
    const repeated = await form(w.bob);
    assert.deepEqual([repeated.status, repeated.headers.get("location")], [302, `/review/${id}`]);
    // A header client that does not ask for JSON (curl, the agent SDK, older scripts) also keeps the redirect.
    const plain = await fetch(`${w.base}/review/${id}/deny`, { method: "POST", redirect: "manual", headers: { "x-reviewer-token": w.bob } });
    assert.equal(plain.status, 302);
    assert.equal(w.resolutions(id), 1);
  } finally { await w.close(); }
});

test("many reviewers deciding at once over HTTP: exactly one request applies it and one event is recorded", async () => {
  const w = await world();
  try {
    const id = await w.escalate();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => w.decide(id, i % 2 ? "deny" : "approve", i % 3 ? w.bob : w.alice)));
    assert.equal(results.filter((r) => r.body.outcome === "applied").length, 1);
    assert.equal(results.filter((r) => r.body.outcome === "already_decided").length, 11);
    assert.equal(w.resolutions(id), 1);
  } finally { await w.close(); }
});

test("separate SQLite connections resolving at the same instant: exactly one transition applies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-resolution-race-"));
  const path = join(dir, "db.sqlite");
  try {
    const evaluation = { decision: "NEEDS_REVIEW", reasons: [], decoded: { feePayer: "p", instructions: [] } } as unknown as PolicyEvaluation;
    const worker = fileURLToPath(new URL("./resolution-worker.js", import.meta.url));
    for (let round = 0; round < 5; round++) {
      const store = new PendingReviewStore({ persistencePath: path });
      const id = store.create("a", evaluation).id;
      const gate = new SharedArrayBuffer(8);
      const flag = new Int32Array(gate);
      const count = 6;
      const outcomes = Array.from({ length: count }, (_, i) => new Promise<string>((resolve, reject) => {
        const w = new Worker(worker, { workerData: { path, id, status: i % 2 ? "DENIED" : "APPROVED", name: `reviewer-${i}`, gate } });
        w.once("message", resolve);
        w.once("error", reject);
      }));
      while (Atomics.load(flag, 1) < count) await new Promise((resolve) => setTimeout(resolve, 5));
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
      const results = await Promise.all(outcomes);
      assert.equal(results.filter((o) => o === "applied").length, 1, `round ${round}: ${results.join(", ")}`);
      assert.equal(results.filter((o) => o === "already_decided").length, count - 1);
      const resolved = store.get(id)!;
      assert.ok(resolved.resolvedBy?.kind === "reviewer");
      // The stored decision is the winner's: its status matches the winner's request.
      const winner = Number((resolved.resolvedBy as { name: string }).name.split("-")[1]);
      assert.equal(resolved.status, winner % 2 ? "DENIED" : "APPROVED");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the in-memory store reports the same three outcomes", async () => {
  const store = new PendingReviewStore({ expiresInMs: 50 });
  const evaluation = { decision: "NEEDS_REVIEW", reasons: [], decoded: { feePayer: "p", instructions: [] } } as unknown as PolicyEvaluation;
  const id = store.create("a", evaluation).id;
  assert.equal(store.resolveOutcome(id, "APPROVED", { kind: "shared-secret" }).outcome, "applied");
  assert.equal(store.resolveOutcome(id, "DENIED", { kind: "shared-secret" }).outcome, "already_decided");
  assert.equal(store.get(id)!.status, "APPROVED");
  const late = store.create("a", evaluation).id;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(store.resolveOutcome(late, "APPROVED", { kind: "shared-secret" }).outcome, "expired");
  assert.equal(store.resolveOutcome("missing", "APPROVED", { kind: "shared-secret" }).outcome, "not_found");
});

test("the page takes its confirmation from the action's own answer, never from the review's final status", () => {
  assert.match(APP_SCRIPT, /accept: "application\/json"/);
  assert.match(APP_SCRIPT, /outcome === "applied"/);
  assert.match(APP_SCRIPT, /outcome === "already_decided"/);
  assert.doesNotMatch(APP_SCRIPT, /r\.body\.status === expected/, "the old inference from final status is gone");
  assert.doesNotMatch(APP_SCRIPT, /opaqueredirect/, "a redirect is no longer read as success");
});
