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
import { describeOutcome, summarizeTransaction } from "../src/escalation/review-view.js";
import { APP_SHELL_HTML as QUEUE_PAGE_HTML, APP_SCRIPT as QUEUE_PAGE_SCRIPT } from "../src/escalation/operator-queue-page.js";
import { AuditLog } from "../src/observability/audit-log.js";
import { TurnkeyLifecycleStore } from "../src/turnkey/lifecycle-store.js";
import type { TurnkeyApi } from "../src/turnkey/api.js";
import { openSqliteDatabase, serializeStoredValue } from "../src/storage/sqlite.js";
import type { PolicyEvaluation, DecodedInstructionSummary } from "../src/policy/types.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";

// An Assign next to a transfer: the demo registry cannot decode it, so it escalates.
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

const ix = (over: Partial<DecodedInstructionSummary>): DecodedInstructionSummary => ({ programId: "P", instructionName: "transfer", fields: {}, mode: "interpolated", accounts: [], ...over });
const evaluationOf = (instructions: DecodedInstructionSummary[], reasons = ["needs a look"]): PolicyEvaluation => ({ decision: "NEEDS_REVIEW", reasons, decoded: { feePayer: "payer", instructions } });

/** A server on a fresh SQLite file with two customers, a reviewer for each, and an operator reviewer. */
async function world(options: Partial<ServerConfig> & { memory?: boolean; lifecycle?: TurnkeyLifecycleStore } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-queue-"));
  const path = options.memory ? undefined : join(dir, "db.sqlite");
  const customers = new CustomerStore({ persistencePath: path });
  const reviewers = new ReviewerStore({ persistencePath: path });
  const mk = (name: string) => {
    const customer = customers.create(name);
    customers.setPolicy(customer.id, policyFor(`${name}-pay`));
    return { customer, apiKey: customers.issueKey(customer.id).apiKey, policyId: `${name}-pay`, reviewer: reviewers.create(`${name} reviewer`, customer.id).token };
  };
  const acme = mk("acme"), globex = mk("globex");
  const operator = reviewers.create("Operator").token;
  const lifecycle = options.lifecycle ?? (path ? new TurnkeyLifecycleStore({ persistencePath: path }) : new TurnkeyLifecycleStore());
  const app = createServer(new Map([["demo", buildDemoPolicy()]]), buildDemoRegistry(), {
    baseUrl: "http://placeholder", persistencePath: path, customers, reviewers, rateLimit: { maxRequests: 10_000, windowMs: 60_000 },
    turnkey: { api: stubTurnkey, wallets: {}, autoStart: false, lifecycle }, ...options
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const list = (token: string | undefined, query = "") => fetch(`${base}/operator/api/reviews${query}`, { headers: token ? { "x-reviewer-token": token } : {} });
  const items = async (token: string, query = "") => {
    const response = await list(token, query);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()) as { scope: string; items: Array<Record<string, any>>; nextCursor: string | null; limit: number };
  };
  const escalate = async (who: { apiKey: string; policyId: string }, agentId = "agent-1") => {
    const response = await fetch(`${base}/evaluate`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${who.apiKey}` }, body: JSON.stringify({ agentId, policyId: who.policyId, transactionBase64: escalatingTx() }) });
    const body = (await response.json()) as { decision: string; reviewId: string };
    assert.equal(body.decision, "NEEDS_REVIEW");
    return body.reviewId;
  };
  return {
    base, path, customers, reviewers, acme, globex, operator, lifecycle, list, items, escalate,
    /** What a signed-in reviewer is shown about a review: the detail API's answer, as text for matching wording. */
    view: async (id: string, token: string) => { const response = await fetch(`${base}/operator/api/reviews/${id}`, { headers: { "x-reviewer-token": token } }); assert.equal(response.status, 200); return response.text(); },
    detail: (id: string, token: string) => fetch(`${base}/operator/api/reviews/${id}`, { headers: { "x-reviewer-token": token } }),
    act: (id: string, token: string, action: "approve" | "deny") => fetch(`${base}/review/${id}/${action}`, { method: "POST", redirect: "manual", headers: { "x-reviewer-token": token } }),
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("queue: without a valid reviewer credential in a header, nothing is listed or shown", async () => {
  const w = await world();
  try {
    const id = await w.escalate(w.acme);
    assert.equal((await w.list(undefined)).status, 401);
    assert.equal((await w.list("agr_not-a-real-token")).status, 401);
    assert.equal((await w.list("anything-else")).status, 401);
    // A token in the query string is never read as a credential.
    assert.equal((await w.list(undefined, `?token=${encodeURIComponent(w.operator)}`)).status, 401);
    assert.equal((await w.list(w.operator, `?token=${encodeURIComponent(w.operator)}`)).status, 400, "and is refused as an unknown parameter");
    assert.equal((await fetch(`${w.base}/operator/api/reviews/${id}`)).status, 401);
    // The page itself carries no review data, no credential, and the same framing and referrer protections.
    const shell = await fetch(`${w.base}/operator/reviews`);
    const html = await shell.text();
    assert.ok(!html.includes(id) && !html.includes("agent-1"));
    assert.match(shell.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(shell.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
    assert.equal(shell.headers.get("cache-control"), "no-store");
    const health = await (await fetch(`${w.base}/healthz`)).text();
    assert.ok(!health.includes(id), "health shows no reviews");
  } finally { await w.close(); }
});

test("queue: with no reviewer and no shared secret, the queue is switched off like the actions", async () => {
  const app = createServer(new Map([["demo", buildDemoPolicy()]]), buildDemoRegistry(), { baseUrl: "http://placeholder" });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/operator/api/reviews`, { headers: { "x-reviewer-token": "agr_x" } });
    assert.equal(response.status, 503);
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
});

for (const mode of ["sqlite", "memory"] as const) {
  test(`queue (${mode}): a customer's reviewer lists and opens only that customer's reviews; an operator reviewer sees all, with the customer`, async () => {
    const w = await world({ memory: mode === "memory" });
    try {
      const acmeId = await w.escalate(w.acme);
      const globexId = await w.escalate(w.globex);
      const acme = await w.items(w.acme.reviewer);
      assert.equal(acme.scope, "customer");
      assert.deepEqual(acme.items.map((i) => i.id), [acmeId]);
      assert.ok(!("customerId" in acme.items[0]!), "a customer's reviewer is not shown customer ids");
      assert.equal((await w.items(w.acme.reviewer, "?status=ALL&agent=agent-1")).items.length, 1);
      assert.equal((await w.detail(globexId, w.acme.reviewer)).status, 404, "another customer's review looks missing");
      assert.equal((await w.detail(acmeId, w.acme.reviewer)).status, 200);
      assert.equal((await w.act(globexId, w.acme.reviewer, "approve")).status, 404, "and cannot be acted on");

      const all = await w.items(w.operator);
      assert.equal(all.scope, "all");
      assert.deepEqual(new Set(all.items.map((i) => i.id)), new Set([acmeId, globexId]));
      assert.deepEqual(new Set(all.items.map((i) => i.customerId)), new Set([w.acme.customer.id, w.globex.customer.id]));
      assert.equal((await w.detail(globexId, w.operator)).status, 200);
    } finally { await w.close(); }
  });
}

test("queue: the shared secret sees all reviews while it is accepted, and nothing once reviewers are required", async () => {
  const secret = "s".repeat(40);
  const open = await world({ reviewActionSecret: secret });
  try {
    await open.escalate(open.acme);
    const response = await fetch(`${open.base}/operator/api/reviews`, { headers: { "x-review-action-secret": secret } });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { scope: string }).scope, "all");
  } finally { await open.close(); }
  const strict = await world({ reviewActionSecret: secret, requireReviewers: true });
  try {
    assert.equal((await fetch(`${strict.base}/operator/api/reviews`, { headers: { "x-review-action-secret": secret } })).status, 401);
  } finally { await strict.close(); }
});

test("queue: filters, page sizes and cursors are validated", async () => {
  const w = await world();
  try {
    for (const bad of ["?status=BOGUS", "?status=pending", "?chain=btc", "?chain=evm:abc", "?limit=0", "?limit=101", "?limit=abc", "?limit=-1", "?cursor=%%%", "?cursor=bm90LWpzb24", `?cursor=${Buffer.from(JSON.stringify({ c: "yesterday", i: "x" })).toString("base64url")}`, "?status=PENDING&status=DENIED", "?agent=", `?agent=${"a".repeat(201)}`, "?agent=%01", "?order=asc"]) {
      const response = await w.list(w.operator, bad);
      assert.equal(response.status, 400, bad);
      assert.equal(((await response.json()) as { error: string }).error, "INVALID_REQUEST", bad);
    }
    for (const good of ["?status=ALL", "?status=EXPIRED", "?chain=solana", "?chain=evm", "?chain=evm:8453", "?chain=unknown", "?limit=1", "?limit=100", "?agent=a%20b"]) assert.equal((await w.list(w.operator, good)).status, 200, good);
    assert.equal((await w.items(w.operator)).limit, 25, "default page size");
  } finally { await w.close(); }
});

test("queue: pages are stable when many reviews share a timestamp, with no repeats and none skipped", async () => {
  const w = await world();
  try {
    const store = new PendingReviewStore({ persistencePath: w.path });
    const ids = Array.from({ length: 23 }, (_, i) => store.create(`agent-${i % 3}`, evaluationOf([]), undefined, `h${i}`, "p", "f", i % 2 ? "solana" : "evm:1").id);
    // Everything at one instant except two, so the tie-breaker decides almost all of the order.
    const db = openSqliteDatabase(w.path!);
    db.prepare("UPDATE pending_reviews SET created_at = '2026-11-10T10:00:00.000Z'").run();
    db.prepare("UPDATE pending_reviews SET created_at = '2026-11-10T11:00:00.000Z' WHERE id = ?").run(ids[5]!);
    db.prepare("UPDATE pending_reviews SET created_at = '2026-11-10T09:00:00.000Z' WHERE id = ?").run(ids[7]!);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await w.items(w.operator, `?status=ALL&limit=4${cursor ? `&cursor=${cursor}` : ""}`);
      assert.ok(page.items.length <= 4);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    const tied = ids.filter((id) => id !== ids[5] && id !== ids[7]).sort().reverse();
    assert.deepEqual(seen, [ids[5]!, ...tied, ids[7]!], "newest first, ties by id, each exactly once");
    // A filtered walk agrees with the unfiltered one.
    const evm: string[] = [];
    cursor = null;
    do {
      const page = await w.items(w.operator, `?status=ALL&chain=evm&limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      evm.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(evm, seen.filter((id) => ids.indexOf(id) % 2 === 0));
  } finally { await w.close(); }
});

test("queue: the in-memory store pages ties the same way", () => {
  const store = new PendingReviewStore();
  const reviews = Array.from({ length: 9 }, () => store.create("a", evaluationOf([])));
  for (const review of reviews) review.createdAt = "2026-11-10T10:00:00.000Z";
  const seen: string[] = [];
  let after: { createdAt: string; id: string } | undefined;
  for (;;) {
    const page = store.list({ scope: "all", limit: 2, after });
    seen.push(...page.reviews.map((r) => r.id));
    if (!page.more) break;
    after = { createdAt: page.reviews.at(-1)!.createdAt, id: page.reviews.at(-1)!.id };
  }
  assert.deepEqual(seen, reviews.map((r) => r.id).sort().reverse());
});

test("queue: a pending review past its expiry is listed as expired, without the list writing anything", async () => {
  const w = await world();
  try {
    const id = await w.escalate(w.acme);
    const db = openSqliteDatabase(w.path!);
    db.prepare("UPDATE pending_reviews SET expires_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(id);
    assert.equal((await w.items(w.operator)).items.length, 0, "not in the default pending view");
    const expired = await w.items(w.operator, "?status=EXPIRED");
    assert.deepEqual(expired.items.map((i) => [i.id, i.status]), [[id, "EXPIRED"]]);
    assert.equal((await w.items(w.operator, "?status=ALL")).items[0]!.status, "EXPIRED");
    assert.equal((db.prepare("SELECT status FROM pending_reviews WHERE id = ?").get(id) as { status: string }).status, "PENDING", "listing wrote nothing");
    assert.match(await w.view(id, w.operator), /expired at 2026-01-01/);
    assert.equal((await w.act(id, w.operator, "approve")).status, 410, "and it cannot be approved");
  } finally { await w.close(); }
  const store = new PendingReviewStore({ expiresInMs: 1 });
  store.create("a", evaluationOf([]));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.list({ scope: "all", status: "PENDING", limit: 10 }).reviews.length, 0);
  assert.equal(store.list({ scope: "all", status: "EXPIRED", limit: 10 }).reviews.length, 1);
});

test("queue and review page keep approval, approval use, vote and execution apart", async () => {
  const w = await world();
  try {
    const approvedOnly = await w.escalate(w.acme);
    const consumed = await w.escalate(w.acme);
    const signed = await w.escalate(w.acme);
    const voted = await w.escalate(w.acme);
    const unknown = await w.escalate(w.acme);
    for (const id of [approvedOnly, consumed, signed, voted, unknown]) assert.equal((await w.act(id, w.acme.reviewer, "approve")).status, 302);
    const db = openSqliteDatabase(w.path!);
    db.prepare("UPDATE pending_reviews SET consumed_at = ? WHERE id IN (?, ?)").run(new Date().toISOString(), consumed, signed);
    new AuditLog({ persistencePath: w.path }).append(w.acme.customer.id, "signed", { viaReview: signed, signature: "sig-123", agentId: "agent-1" });
    for (const [id, activity, state] of [[voted, "act-1", "APPROVED"], [unknown, "act-2", "VOTE_UNKNOWN"]] as const) {
      w.lifecycle.claim({ organizationId: "org", activityId: activity, voteFingerprint: "fp", wallet: "w", customerId: w.acme.customer.id, agentId: "agent-1", policyId: "acme-pay", transactionHash: "h", policyFingerprint: "f" });
      w.lifecycle.update("org", activity, { state, reviewId: id });
    }

    const byId = new Map((await w.items(w.acme.reviewer, "?status=APPROVED")).items.map((i) => [i.id, i]));
    assert.equal(byId.get(approvedOnly)!.approvalUsed, false);
    assert.equal(byId.get(consumed)!.approvalUsed, true);
    assert.equal(byId.get(voted)!.turnkey.label, "Vote completed");
    assert.equal(byId.get(unknown)!.turnkey.label, "Outcome unknown");
    assert.equal(byId.get(approvedOnly)!.turnkey, null);

    const approvedPage = await w.view(approvedOnly, w.acme.reviewer);
    assert.match(approvedPage, /Not used yet\./);
    assert.match(approvedPage, /No recorded signing outcome/);
    const consumedPage = await w.view(consumed, w.acme.reviewer);
    assert.match(consumedPage, /Using an approval is not proof that anything was signed/);
    assert.match(consumedPage, /No recorded signing outcome/, "a used approval is not a signature");
    const signedPage = await w.view(signed, w.acme.reviewer);
    assert.match(signedPage, /Signed and sent/);
    assert.match(signedPage, /Whether it executed on chain is not recorded here/);
    const votedPage = await w.view(voted, w.acme.reviewer);
    assert.match(votedPage, /Vote completed/);
    assert.match(votedPage, /does not show that the transaction was signed or executed on chain/);
    assert.match(await w.view(unknown, w.acme.reviewer), /Outcome unknown/);
    for (const page of [approvedPage, consumedPage, signedPage, votedPage]) assert.doesNotMatch(page, /(was|were) executed|executed successfully|confirmed on chain/i, "nothing claims execution");

    const detail = (await (await w.detail(unknown, w.acme.reviewer)).json()) as { outcome: { kind: string; state: string }; approvalUsed: boolean };
    assert.deepEqual([detail.outcome.kind, detail.outcome.state], ["turnkey", "VOTE_UNKNOWN"]);
  } finally { await w.close(); }
});

test("summaries count transfers per asset and never add unlike assets or invent one recipient", () => {
  assert.equal(summarizeTransaction(evaluationOf([ix({ destination: "D1", amount: 5n, asset: "native" })])).text, "Transfer of 5 native to D1");
  const mixed = summarizeTransaction(evaluationOf([
    ix({ destination: "D1", amount: 5n, asset: "native" }), ix({ destination: "D2", amount: 7n, asset: "USDC" }), ix({ destination: "D3", amount: 9n, asset: "native" })
  ]));
  assert.equal(mixed.text, "3 transfers across 2 assets to 3 destinations");
  assert.equal(mixed.single, undefined);
  assert.deepEqual(mixed.assets.map((a) => [a.asset, a.total, a.transfers]), [["native", 14n, 2], ["USDC", 7n, 1]]);
  assert.equal(summarizeTransaction(evaluationOf([ix({ destination: "D1", amount: 5n }), ix({ destination: "D1", amount: 6n })])).text, "2 transfers totalling 11 native to 1 destination");
  assert.equal(summarizeTransaction(evaluationOf([ix({ destination: "D1", amount: 5n }), ix({ mode: "raw_dump", destination: "X", amount: 1n }), ix({ instructionName: "assign" })])).text,
    "Transfer of 5 native to D1; 1 other instruction (assign); 1 instruction could not be decoded");
  assert.equal(summarizeTransaction(evaluationOf([])).text, "No instructions decoded");
  assert.equal(summarizeTransaction(evaluationOf([ix({ swap: { inAmount: 3n, sourceMint: "MintA", destinationMint: "MintB", destinationTokenAccount: "S" } as never, amount: 3n, destination: "S" })])).text,
    "Swap of up to 3 MintA for MintB", "a swap is a swap, not a transfer to its output account");
});

test("hostile agent names, reasons, decoded fields and AI notes are shown as text, never as markup", async () => {
  const w = await world();
  try {
    const evil = `<img src=x onerror=alert(1)>"'&`;
    const store = new PendingReviewStore({ persistencePath: w.path });
    const review = store.create(evil, evaluationOf([ix({ programId: evil, instructionName: `<script>alert(2)</script>`, fields: { note: evil }, destination: evil, amount: 1n })], [`reason ${evil}`]), undefined, "h", `policy${evil}`, "f", "solana");
    store.attachExplanation(review.id, { model: `<b>m</b>`, summary: `<script>alert(3)</script>`, risks: [evil], truncated: false } as never);
    w.lifecycle.claim({ organizationId: "org", activityId: `act${evil}`, voteFingerprint: "fp", wallet: "w", agentId: evil, policyId: "p", transactionHash: "h" });
    w.lifecycle.update("org", `act${evil}`, { state: "MISMATCH", reviewId: review.id, detail: `<script>alert(4)</script> free text` });
    // Signed out, the page is the same shell as for any id: no review data at all.
    const html = await (await fetch(`${w.base}/review/${review.id}`)).text();
    assert.equal(html, QUEUE_PAGE_HTML);
    for (const raw of ["img src=x", "alert(", "<b>m</b>", "free text"]) assert.ok(!html.includes(raw), raw);
    // Signed in, the data arrives as JSON for the script to place as text.
    const api = await w.detail(review.id, w.operator);
    assert.match(api.headers.get("content-type") ?? "", /application\/json/);
    const body = (await api.json()) as { agentId: string; advisoryExplanation: { summary: string }; instructions: Array<{ instructionName: string }> };
    assert.deepEqual([body.agentId, body.advisoryExplanation.summary, body.instructions[0]!.instructionName], [evil, "<script>alert(3)</script>", "<script>alert(2)</script>"]);
    // The script never turns data into markup, and the shell runs no inline script.
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "srcdoc"]) assert.ok(!QUEUE_PAGE_SCRIPT.includes(sink), sink);
    assert.ok(!/<script>(?!<\/script>)[^<]/.test(QUEUE_PAGE_HTML), "no inline script in the page");
  } finally { await w.close(); }
});

test("from the queue to the review page, approve and deny go through the existing actions", async () => {
  const w = await world();
  try {
    const first = await w.escalate(w.acme, "payroll-bot");
    const second = await w.escalate(w.acme, "payroll-bot");
    const queue = await w.items(w.acme.reviewer);
    assert.deepEqual(new Set(queue.items.map((i) => i.id)), new Set([first, second]));
    assert.equal(queue.items[0]!.chain, "solana");
    // The Assign instruction is one the demo registry cannot decode, and the summary says so.
    assert.match(queue.items[0]!.summary.text, /^Transfer of 1000 native to \w+; 1 instruction could not be decoded$/);
    const page = await (await fetch(`${w.base}/review/${first}`)).text();
    assert.equal(page, QUEUE_PAGE_HTML, "the review link opens the sign-in shell");
    assert.equal((await w.act(first, w.acme.reviewer, "approve")).status, 302);
    assert.equal((await w.act(second, w.operator, "deny")).status, 302);
    assert.equal((await w.items(w.acme.reviewer)).items.length, 0, "nothing left waiting");
    const approved = (await w.items(w.acme.reviewer, "?status=APPROVED")).items;
    assert.deepEqual([approved[0]!.id, approved[0]!.resolvedBy], [first, { kind: "reviewer", name: "acme reviewer" }]);
    assert.deepEqual((await w.items(w.acme.reviewer, "?status=DENIED")).items[0]!.resolvedBy, { kind: "reviewer", name: "Operator" });
    assert.match(await w.view(first, w.acme.reviewer), /Approved by acme reviewer/);
    assert.equal((await fetch(`${w.base}/review/${first}/approve`)).status, 404, "no GET route changes anything");
  } finally { await w.close(); }
});

test("an older database gains the queue's column and indexes in place, twice safely, without rewriting old reviews", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-queue-migrate-"));
  const path = join(dir, "db.sqlite");
  try {
    const old = openSqliteDatabase(path);
    old.exec(`CREATE TABLE pending_reviews (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, evaluation_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED')), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT) STRICT;`);
    const later = new Date(Date.now() + 600_000).toISOString();
    old.prepare("INSERT INTO pending_reviews VALUES ('legacy', 'agent', ?, 'PENDING', ?, ?, NULL)").run(serializeStoredValue(evaluationOf([])), new Date().toISOString(), later);
    const audit = new AuditLog({ persistencePath: path });
    audit.append(undefined, "signed", { viaReview: "legacy", signature: "s" });
    new PendingReviewStore({ persistencePath: path });
    const store = new PendingReviewStore({ persistencePath: path });
    new AuditLog({ persistencePath: path });
    new TurnkeyLifecycleStore({ persistencePath: path });
    new TurnkeyLifecycleStore({ persistencePath: path });
    const db = openSqliteDatabase(path);
    assert.ok((db.prepare("PRAGMA table_info(pending_reviews)").all() as Array<{ name: string }>).some((c) => c.name === "chain"));
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const name of ["pending_reviews_list", "pending_reviews_list_status", "pending_reviews_list_customer", "pending_reviews_list_customer_status", "audit_events_signing_by_review", "audit_events_refusal_by_review", "turnkey_activities_review"]) assert.ok(indexes.includes(name), name);
    const legacy = store.list({ scope: "all", chain: "unknown", limit: 10 }).reviews;
    assert.deepEqual(legacy.map((r) => [r.id, r.chain]), [["legacy", undefined]], "no chain is invented for an old review");
    assert.equal(store.list({ scope: "all", chain: "solana", limit: 10 }).reviews.length, 0);
    assert.equal(audit.forReview(undefined, "legacy").signing?.data.signature, "s", "old events are found through the new index");
    assert.equal(audit.verify(undefined).ok, true, "and the chain still verifies");
    assert.throws(() => db.prepare("UPDATE audit_events SET type = 'x'").run(), /append-only/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a large history: one page is read through an index, and the Turnkey state of a page is fetched in one query", async () => {
  class CountingLifecycle extends TurnkeyLifecycleStore {
    batches = 0; singles = 0;
    override byReviewIds(ids: readonly string[]) { this.batches += 1; return super.byReviewIds(ids); }
    override get(org: string, id: string) { this.singles += 1; return super.get(org, id); }
  }
  const dir = mkdtempSync(join(tmpdir(), "agentguard-queue-large-"));
  const path = join(dir, "db.sqlite");
  const lifecycle = new CountingLifecycle({ persistencePath: path });
  const w = await world({ persistencePath: path, lifecycle });
  try {
    new PendingReviewStore({ persistencePath: path });
    const db = openSqliteDatabase(path);
    const insert = db.prepare("INSERT INTO pending_reviews (id, agent_id, evaluation_json, status, created_at, expires_at, customer_id, chain) VALUES (?, ?, ?, ?, ?, ?, ?, 'solana')");
    const evaluation = serializeStoredValue(evaluationOf([ix({ destination: "D", amount: 1n })]));
    db.exec("BEGIN");
    for (let i = 0; i < 20_000; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
      insert.run(`r-${String(i).padStart(6, "0")}`, `agent-${i % 50}`, evaluation, i % 4 === 0 ? "PENDING" : "DENIED", at, "2099-01-01T00:00:00.000Z", i % 2 ? w.acme.customer.id : w.globex.customer.id);
    }
    db.exec("COMMIT");
    for (let i = 0; i < 30; i++) {
      lifecycle.claim({ organizationId: "org", activityId: `a${i}`, voteFingerprint: "f", wallet: "w", agentId: "x", policyId: "p", transactionHash: "h" });
      lifecycle.update("org", `a${i}`, { state: "REVIEW_OPEN", reviewId: `r-${String(19_999 - i).padStart(6, "0")}` });
    }
    lifecycle.batches = 0; lifecycle.singles = 0;
    const page = await w.items(w.operator, "?status=ALL&limit=100");
    assert.equal(page.items.length, 100);
    assert.equal(page.items[0]!.id, "r-019999");
    assert.equal(page.items.filter((i) => i.turnkey).length, 30);
    assert.deepEqual([lifecycle.batches, lifecycle.singles], [1, 0], "one batched lookup, no per-row queries");

    // Every shape the queue asks is answered from an index in order, with no full scan or sort of the history.
    const plan = (sql: string, ...args: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");
    const shape = (where: string) => `SELECT r.id FROM pending_reviews r LEFT JOIN review_resolutions res ON res.review_id = r.id ${where} ORDER BY r.created_at DESC, r.id DESC LIMIT 26`;
    for (const [where, index] of [
      ["", "pending_reviews_list"],
      ["WHERE r.status = 'DENIED'", "pending_reviews_list_status"],
      ["WHERE r.customer_id = 'c'", "pending_reviews_list_customer"],
      ["WHERE r.customer_id = 'c' AND r.status = 'DENIED'", "pending_reviews_list_customer_status"]
    ] as const) {
      const detail = plan(shape(where));
      assert.match(detail, new RegExp(`USING (COVERING )?INDEX ${index}\\b`), detail);
      assert.doesNotMatch(detail, /TEMP B-TREE/, detail);
    }
    // Pending reviews are searched by the expiry index, so only those not yet expired are read and sorted: a set the
    // review window bounds, however long the history.
    const pending = plan(shape("WHERE r.status = 'PENDING' AND r.expires_at > '2099-01-01T00:00:00.000Z'"));
    assert.match(pending, /USING INDEX pending_reviews_status_expires_at \(status=\? AND expires_at>\?\)/, pending);
    assert.match(plan("SELECT n FROM audit_events WHERE type IN ('signed', 'signing_failed') AND scope = ? AND json_extract(data_json, '$.viaReview') = ? ORDER BY n DESC LIMIT 1", "open", "r"), /USING INDEX audit_events_signing_by_review/);
    assert.match(plan("SELECT * FROM turnkey_activities WHERE review_id IN (?, ?)", "a", "b"), /USING INDEX turnkey_activities_review/);

    const started = performance.now();
    for (let i = 0; i < 20; i++) await w.items(w.acme.reviewer, "?status=PENDING&limit=25");
    assert.ok(performance.now() - started < 5_000, "pages stay quick over a long history");
  } finally { await w.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("Turnkey outcome wording keeps the vote, the signing request, unknown outcomes and retained accounting apart", () => {
  const base = { organizationId: "org", activityId: "sign-1", voteFingerprint: "fp", wallet: "W", agentId: "a", policyId: "p", transactionHash: "h", voteSubmissions: 1, retries: 0, createdAt: "t", updatedAt: "t" };
  const reservation = { id: "turnkey:org:sign-1", policyId: "p", date: "2026-11-10", amounts: { native: 1n } };
  const outcome = (state: string, extra: object = {}) => describeOutcome({ ...base, state, reservation, ...extra } as never, undefined, "APPROVED") as { label: string; meaning: string; accountingRetained: boolean };
  const pending = outcome("VOTE_PENDING", { voteActivityId: "vote-9" });
  assert.equal(pending.label, "Vote submission pending");
  assert.equal(pending.accountingRetained, true);
  assert.match(pending.meaning, /Accounting retained pending reconciliation/);
  const voted = outcome("APPROVED");
  assert.equal(voted.label, "Vote completed");
  assert.match(voted.meaning, /does not show that the transaction was signed or executed on chain/);
  assert.equal(voted.accountingRetained, false, "a completed vote's charge is spent, not retained pending anything");
  const signed = outcome("SIGNING_COMPLETED");
  assert.equal(signed.label, "Original signing request completed");
  assert.match(signed.meaning, /Whether the transaction executed on chain is not recorded here/);
  assert.equal(outcome("VOTE_UNKNOWN").label, "Outcome unknown");
  assert.match(voted.meaning, /keeps reading it, without voting again, until Turnkey finishes it or 7 days pass/);
  assert.match(outcome("VOTE_REFUSED").meaning, /keeps reading the request until Turnkey finishes it or 7 days pass/);
  const unresolved = outcome("SIGNING_UNRESOLVED");
  assert.equal(unresolved.label, "Signing outcome not observed");
  assert.match(unresolved.meaning, /Check the request in Turnkey/);
  assert.equal(unresolved.accountingRetained, true);
  for (const state of ["VOTE_UNKNOWN", "VOTE_REFUSED", "RESOLVED_EXTERNALLY", "REJECTED", "MISMATCH", "VOTING"]) {
    const o = outcome(state);
    assert.equal(o.accountingRetained, true, state);
    assert.match(o.meaning, /can overcount the day's spending/, state);
  }
  for (const state of ["VOTE_PENDING", "APPROVED", "SIGNING_COMPLETED", "VOTE_UNKNOWN", "VOTE_REFUSED"]) {
    assert.doesNotMatch(outcome(state).meaning, /(was|were) executed|executed successfully|confirmed on chain|given back/i, state);
  }
});
