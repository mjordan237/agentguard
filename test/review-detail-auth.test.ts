import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createServer, type ServerConfig } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { PendingReviewStore } from "../src/escalation/pending-store.js";
import { APP_SHELL_HTML, APP_SCRIPT } from "../src/escalation/operator-queue-page.js";
import { TurnkeyLifecycleStore } from "../src/turnkey/lifecycle-store.js";
import type { TurnkeyApi } from "../src/turnkey/api.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";

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
const policyFor = (policyId: string) => ({
  policyId, programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [], allowAnyDestination: true,
  maxAmountPerTransaction: { native: "1000000000" }, maxAmountPerDay: { native: "5000000000" }
});
const idle = async () => { throw new Error("not used"); };
const stubTurnkey = { scanWaitingActivities: idle, listWaitingActivities: idle, getActivity: idle, approve: idle, reject: idle } as unknown as TurnkeyApi;

async function world(options: Partial<ServerConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-detail-"));
  const path = join(dir, "db.sqlite");
  const customers = new CustomerStore({ persistencePath: path });
  const reviewers = new ReviewerStore({ persistencePath: path });
  const mk = (name: string) => {
    const customer = customers.create(name);
    customers.setPolicy(customer.id, policyFor(`${name}-pay`));
    const reviewer = reviewers.create(`${name} reviewer`, customer.id);
    return { customer, apiKey: customers.issueKey(customer.id).apiKey, policyId: `${name}-pay`, reviewer: reviewer.token, reviewerId: reviewer.reviewer.id };
  };
  const acme = mk("acme"), globex = mk("globex");
  const operator = reviewers.create("Operator").token;
  const lifecycle = new TurnkeyLifecycleStore({ persistencePath: path });
  const app = createServer(new Map([["demo", buildDemoPolicy()]]), buildDemoRegistry(), {
    baseUrl: "http://placeholder", persistencePath: path, customers, reviewers, rateLimit: { maxRequests: 10_000, windowMs: 60_000 },
    turnkey: { api: stubTurnkey, wallets: {}, autoStart: false, lifecycle }, ...options
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const escalate = async (who: { apiKey: string; policyId: string }) => {
    const body = (await (await fetch(`${base}/evaluate`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${who.apiKey}` }, body: JSON.stringify({ agentId: "agent-1", policyId: who.policyId, transactionBase64: escalatingTx() }) })).json()) as { reviewId: string };
    return body.reviewId;
  };
  return {
    base, path, reviewers, acme, globex, operator, lifecycle, escalate,
    shell: (id: string) => fetch(`${base}/review/${id}`),
    detail: (id: string, headers: Record<string, string>) => fetch(`${base}/operator/api/reviews/${id}`, { headers }),
    act: (id: string, action: "approve" | "deny", headers: Record<string, string>) => fetch(`${base}/review/${id}/${action}`, { method: "POST", redirect: "manual", headers }),
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); rmSync(dir, { recursive: true, force: true }); }
  };
}
const as = (token: string) => ({ "x-reviewer-token": token });

test("signed out, a review link opens the same data-free sign-in shell for a real id and a missing one", async () => {
  const w = await world();
  try {
    const id = await w.escalate(w.acme);
    const real = await w.shell(id);
    const missing = await w.shell("00000000-0000-4000-8000-000000000000");
    const junk = await w.shell("not-a-review");
    const bodies = await Promise.all([real.text(), missing.text(), junk.text()]);
    assert.deepEqual([real.status, missing.status, junk.status], [200, 200, 200]);
    assert.ok(bodies.every((b) => b === APP_SHELL_HTML), "identical bytes, whatever the id");
    for (const header of ["content-security-policy", "x-frame-options", "referrer-policy", "cache-control", "content-type"]) {
      assert.equal(real.headers.get(header), missing.headers.get(header), header);
    }
    assert.match(real.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.match(real.headers.get("content-security-policy")!, /script-src 'self'/);
    assert.doesNotMatch(real.headers.get("content-security-policy")!, /unsafe-eval|script-src[^;]*unsafe-inline/);
    assert.equal(real.headers.get("referrer-policy"), "no-referrer");
    assert.equal(real.headers.get("cache-control"), "no-store");
    assert.equal(real.headers.get("x-frame-options"), "DENY");
    // Nothing about the review: no id, agent, policy, customer, reasons, instructions or lifecycle words.
    for (const leak of [id, "agent-1", "acme", "acme-pay", w.acme.customer.id, "not on the allowlist", "11111111111111111111111111111111", "Turnkey:", "Decoded instructions"]) {
      assert.ok(!bodies[0]!.includes(leak), leak);
    }
    assert.ok(!real.headers.get("set-cookie"), "no cookie is set");
  } finally { await w.close(); }
});

test("signed in, a customer's reviewer reads and acts on only their own reviews; an operator reads all", async () => {
  const w = await world();
  try {
    const mine = await w.escalate(w.acme);
    const theirs = await w.escalate(w.globex);
    const own = await w.detail(mine, as(w.acme.reviewer));
    assert.equal(own.status, 200);
    const body = (await own.json()) as Record<string, unknown>;
    assert.equal(body.id, mine);
    assert.ok(!("customerId" in body), "a customer's reviewer is not shown customer ids");

    const other = await w.detail(theirs, as(w.acme.reviewer));
    const missing = await w.detail("00000000-0000-4000-8000-000000000000", as(w.acme.reviewer));
    assert.deepEqual([other.status, missing.status], [404, 404]);
    assert.equal(await other.text(), await missing.text(), "another customer's review is indistinguishable from a missing one");
    assert.equal((await w.act(theirs, "approve", as(w.acme.reviewer))).status, 404);
    assert.equal((await w.act(theirs, "deny", as(w.acme.reviewer))).status, 404);
    assert.equal(((await (await w.detail(theirs, as(w.operator))).json()) as { status: string; customerId: string }).status, "PENDING", "left untouched");

    const op = (await (await w.detail(theirs, as(w.operator))).json()) as { customerId: string };
    assert.equal(op.customerId, w.globex.customer.id);
  } finally { await w.close(); }
});

test("invalid and revoked credentials read nothing and change nothing, and errors never echo them", async () => {
  const w = await world();
  try {
    const id = await w.escalate(w.acme);
    const bogus = "agr_" + "x".repeat(43);
    const attempts: Array<Record<string, string>> = [{}, as(bogus), as("plainly wrong"), { "x-review-action-secret": "guess" }];
    for (const headers of attempts) {
      const read = await w.detail(id, headers);
      assert.equal(read.status, 401);
      const text = await read.text();
      assert.ok(!text.includes(bogus) && !text.includes("plainly wrong") && !text.includes("guess"), "the credential is not echoed");
      assert.equal((await w.act(id, "approve", headers)).status, 401);
    }
    assert.equal((await w.detail(id, as(w.acme.reviewer))).status, 200);
    assert.ok(w.reviewers.revoke(w.acme.reviewerId));
    assert.equal((await w.detail(id, as(w.acme.reviewer))).status, 401, "revoked at once");
    assert.equal((await w.act(id, "approve", as(w.acme.reviewer))).status, 401);
    assert.equal(((await (await w.detail(id, as(w.operator))).json()) as { status: string }).status, "PENDING");
  } finally { await w.close(); }
});

test("approve and deny from the signed-in page: header-only POSTs to the existing actions, recorded once", async () => {
  const w = await world();
  try {
    const a = await w.escalate(w.acme);
    const b = await w.escalate(w.acme);
    // Exactly what the page sends: the token in a header, no body, no form field, nothing in the URL.
    const approved = await fetch(`${w.base}/review/${a}/approve`, { method: "POST", redirect: "manual", headers: { "x-reviewer-token": w.acme.reviewer, accept: "application/json" } });
    assert.equal(approved.status, 200);
    const answer = await approved.text();
    assert.deepEqual(JSON.parse(answer), { id: a, requested: "APPROVED", outcome: "applied", status: "APPROVED" }, "an explicit answer for this request");
    assert.ok(!answer.includes(w.acme.reviewer), "which names the review, not the token");
    assert.ok(!approved.headers.get("set-cookie"));
    assert.equal((await w.act(b, "deny", as(w.acme.reviewer))).status, 302);
    const after = (await (await w.detail(a, as(w.acme.reviewer))).json()) as { status: string; actionable: boolean; steps: Array<{ step: string; text: string }> };
    assert.equal(after.status, "APPROVED");
    assert.equal(after.actionable, false);
    assert.match(after.steps.find((s) => s.step === "decision")!.text, /^Approved by acme reviewer at /);
    assert.match(after.steps.find((s) => s.step === "approval")!.text, /^Not used yet\.$/);
    // A second decision does not flip it.
    assert.equal((await w.act(a, "deny", as(w.operator))).status, 302);
    assert.equal(((await (await w.detail(a, as(w.operator))).json()) as { status: string }).status, "APPROVED");
    assert.equal(((await (await w.detail(b, as(w.acme.reviewer))).json()) as { status: string }).status, "DENIED");
    // No GET route changes anything.
    assert.equal((await fetch(`${w.base}/review/${b}/approve`)).status, 404);
  } finally { await w.close(); }
});

test("the shared secret reads every review while accepted, and nothing once reviewers are required", async () => {
  const secret = "s".repeat(40);
  const open = await world({ reviewActionSecret: secret });
  try {
    const id = await open.escalate(open.acme);
    assert.equal((await open.detail(id, { "x-review-action-secret": secret })).status, 200);
    assert.equal((await open.act(id, "approve", { "x-review-action-secret": secret })).status, 302);
  } finally { await open.close(); }
  const strict = await world({ reviewActionSecret: secret, requireReviewers: true });
  try {
    const id = await strict.escalate(strict.acme);
    assert.equal((await strict.detail(id, { "x-review-action-secret": secret })).status, 401);
    assert.equal((await strict.act(id, "approve", { "x-review-action-secret": secret })).status, 401);
  } finally { await strict.close(); }
});

test("a customer's reviewer gets a Turnkey rejection's stable code, not its free text naming another assignment", async () => {
  const w = await world();
  try {
    const id = await w.escalate(w.acme);
    w.lifecycle.claim({ organizationId: "org", activityId: "act-1", voteFingerprint: "fp", wallet: "W", customerId: w.acme.customer.id, agentId: "agent-1", policyId: "acme-pay", transactionHash: "h", policyFingerprint: "f" });
    w.lifecycle.update("org", "act-1", { state: "MISMATCH", reviewId: id, detail: `ASSIGNMENT_CHANGED: The wallet is now assigned to customer ${w.globex.customer.id}, agent other-agent, policy globex-pay.` });
    const scoped = await (await w.detail(id, as(w.acme.reviewer))).text();
    assert.ok(!scoped.includes(w.globex.customer.id), "another customer's id is not shown to this customer");
    assert.ok(!scoped.includes("other-agent"));
    const parsed = JSON.parse(scoped) as { steps: Array<{ step: string; code?: string; badge?: string }> };
    const outcome = parsed.steps.find((s) => s.step === "outcome")!;
    assert.deepEqual([outcome.badge, outcome.code], ["Mismatch, rejected", "ASSIGNMENT_CHANGED"]);
    const operator = (await (await w.detail(id, as(w.operator))).json()) as { turnkeyActivity: { detail?: string } };
    assert.match(operator.turnkeyActivity.detail ?? "", /ASSIGNMENT_CHANGED: /, "operators keep the diagnostics");
  } finally { await w.close(); }
});

test("a decided review whose Turnkey request has not been voted on yet is not shown as waiting for review", async () => {
  const w = await world();
  try {
    const id = await w.escalate(w.acme);
    w.lifecycle.claim({ organizationId: "org", activityId: "act-2", voteFingerprint: "fp", wallet: "W", customerId: w.acme.customer.id, agentId: "agent-1", policyId: "acme-pay", transactionHash: "h", policyFingerprint: "f" });
    w.lifecycle.update("org", "act-2", { state: "REVIEW_OPEN", reviewId: id });
    const outcomeOf = async () => ((await (await w.detail(id, as(w.acme.reviewer))).json()) as { steps: Array<{ step: string; badge?: string }> }).steps.find((s) => s.step === "outcome")!.badge;
    assert.equal(await outcomeOf(), "Waiting for review");
    new PendingReviewStore({ persistencePath: w.path }).resolve(id, "APPROVED", { kind: "shared-secret" });
    assert.equal(await outcomeOf(), "Decision not yet acted on");
  } finally { await w.close(); }
});

test("the page script keeps the token in memory only: no storage, cookies, URLs or forms carry it", () => {
  for (const banned of ["localStorage", "sessionStorage", "document.cookie", "indexedDB", "caches.", "postMessage", "?token", "token=", "name=\"token\"", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.ok(!APP_SCRIPT.includes(banned), banned);
  }
  // The token goes out in one place: the request header.
  assert.match(APP_SCRIPT, /"x-reviewer-token": token/);
  assert.match(APP_SCRIPT, /credentials: "omit"/);
  assert.match(APP_SCRIPT, /referrerPolicy: "no-referrer"/);
  // The sign-in form has no name on the token field, so even a fallback submission could not send it.
  assert.doesNotMatch(APP_SHELL_HTML, /<input[^>]*id="token"[^>]*name=/);
  assert.match(APP_SHELL_HTML, /<form id="login"[^>]*method="post"/);
});
