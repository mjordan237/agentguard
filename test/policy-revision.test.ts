import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { PendingReviewStore } from "../src/escalation/pending-store.js";
import { LocalKeySigner } from "../src/evm/sign.js";
import { policyFingerprint } from "../src/policy/fingerprint.js";
import { openSqliteDatabase, serializeStoredValue } from "../src/storage/sqlite.js";
import type { Policy, PolicyEvaluation } from "../src/policy/types.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";
import { readReview } from "./review-detail-helper.js";

const SECRET = "test-secret";
const listen = (server: http.Server) => new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
  server.listen(0, () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) })));
const tempDb = () => { const dir = mkdtempSync(join(tmpdir(), "agentguard-revision-")); return { path: join(dir, "db.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }; };

const evaluation = { decision: "NEEDS_REVIEW", reasons: ["test"], decoded: { feePayer: "x", instructions: [] } } as unknown as PolicyEvaluation;
const basePolicy = (): Policy => ({ policyId: "p", programAllowlist: ["a", "b"], destinationAllowlist: ["d"], maxAmountPerTransaction: { native: "10" }, maxAmountPerDay: { native: "100" } });

test("the policy fingerprint ignores key order and changes with any rule", () => {
  const policy = basePolicy();
  const reordered = Object.fromEntries(Object.entries(policy).reverse()) as unknown as Policy;
  assert.equal(policyFingerprint(reordered), policyFingerprint(policy), "key order is not a new revision");
  assert.equal(policyFingerprint({ ...policy, maxAmountPerDay: { native: "100" } }), policyFingerprint(policy), "an equal copy is the same revision");
  assert.notEqual(policyFingerprint({ ...policy, maxAmountPerDay: { native: "101" } }), policyFingerprint(policy), "a changed limit is a new revision");
  assert.notEqual(policyFingerprint({ ...policy, allowAnyDestination: true }), policyFingerprint(policy), "an added field is a new revision");
  assert.notEqual(policyFingerprint({ ...policy, programAllowlist: ["b", "a"] }), policyFingerprint(policy), "array order counts, as documented");
  assert.match(policyFingerprint(policy), /^[0-9a-f]{64}$/);
});

test("the review store binds an approval to customer, agent, transaction, policy and revision, across a reopen", () => {
  const db = tempDb();
  try {
    const context = { agentId: "agent", policyId: "p", policyFingerprint: policyFingerprint(basePolicy()) };
    const first = new PendingReviewStore({ persistencePath: db.path });
    const review = first.create("agent", evaluation, "cust", "hash", "p", context.policyFingerprint);
    first.resolve(review.id, "APPROVED", { kind: "shared-secret" });

    const store = new PendingReviewStore({ persistencePath: db.path }); // a restart
    assert.equal(store.get(review.id)?.policyFingerprint, context.policyFingerprint, "the revision survives a reopen");
    assert.equal(store.consumeApproved(review.id, "hash", "other", context), "not_found", "another customer");
    assert.equal(store.consumeApproved(review.id, "other-hash", "cust", context), "mismatch", "another transaction");
    assert.equal(store.consumeApproved(review.id, "hash", "cust", { ...context, agentId: "other" }), "mismatch", "another agent");
    assert.equal(store.consumeApproved(review.id, "hash", "cust", { ...context, policyId: "q" }), "mismatch", "another policy");
    assert.equal(store.consumeApproved(review.id, "hash", "cust", { ...context, policyFingerprint: policyFingerprint({ ...basePolicy(), maxAmountPerDay: { native: "999" } }) }), "policy_changed", "same policy id, new rules");
    assert.equal(store.consumeApproved(review.id, "hash", "cust", context), "ok", "the right caller under unchanged rules");
    assert.equal(store.consumeApproved(review.id, "hash", "cust", context), "already_used", "still single use");
  } finally { db.cleanup(); }
});

test("an older review database is migrated in place, twice safely, and its reviews stay readable but must be reviewed again", () => {
  const db = tempDb();
  try {
    // The schema before transaction hashes, policies and revisions were recorded.
    const old = openSqliteDatabase(db.path);
    old.exec(`CREATE TABLE pending_reviews (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, evaluation_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED')), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, resolved_at TEXT) STRICT;`);
    const now = new Date();
    old.prepare("INSERT INTO pending_reviews VALUES (?, ?, ?, 'APPROVED', ?, ?, ?)").run("legacy", "agent", serializeStoredValue(evaluation), now.toISOString(), new Date(now.getTime() + 600_000).toISOString(), now.toISOString());

    new PendingReviewStore({ persistencePath: db.path });
    const store = new PendingReviewStore({ persistencePath: db.path }); // the migration runs again without error
    const columns = (openSqliteDatabase(db.path).prepare("PRAGMA table_info(pending_reviews)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const column of ["customer_id", "transaction_hash", "consumed_at", "policy_id", "policy_fingerprint", "consumed_by"]) assert.ok(columns.includes(column), column);

    assert.equal(store.get("legacy")?.status, "APPROVED", "a legacy review can still be read");
    assert.equal(store.get("legacy")?.policyFingerprint, undefined);
    // Give it everything else it needs, so only the missing revision stands in the way.
    openSqliteDatabase(db.path).prepare("UPDATE pending_reviews SET transaction_hash = 'hash', policy_id = 'p' WHERE id = 'legacy'").run();
    assert.equal(store.consumeApproved("legacy", "hash", undefined, { agentId: "agent", policyId: "p", policyFingerprint: policyFingerprint(basePolicy()) }), "policy_changed", "fails closed");
    assert.equal(store.get("legacy")?.consumedAt, undefined, "and is not spent");
  } finally { db.cleanup(); }
});

test("only the caller that spent an approval can prove it, and only while every other check still holds", () => {
  const db = tempDb();
  try {
    const context = { agentId: "agent", policyId: "p", policyFingerprint: policyFingerprint(basePolicy()) };
    const first = new PendingReviewStore({ persistencePath: db.path });
    const review = first.create("agent", evaluation, "cust", "hash", "p", context.policyFingerprint);
    first.resolve(review.id, "APPROVED", { kind: "shared-secret" });
    assert.equal(first.spentBy(review.id, "hash", "cust", context, "me"), "not_consumed");
    assert.equal(first.consumeApproved(review.id, "hash", "cust", context, "me"), "ok");

    const store = new PendingReviewStore({ persistencePath: db.path }); // a restart
    assert.equal(store.spentBy(review.id, "hash", "cust", context, "me"), "ok");
    assert.equal(store.spentBy(review.id, "hash", "cust", context, "someone-else"), "consumed_elsewhere");
    assert.equal(store.spentBy(review.id, "hash", "other", context, "me"), "not_found", "another customer");
    assert.equal(store.spentBy(review.id, "other-hash", "cust", context, "me"), "mismatch", "another transaction");
    assert.equal(store.spentBy(review.id, "hash", "cust", { ...context, agentId: "other" }, "me"), "mismatch", "another agent");
    assert.equal(store.spentBy(review.id, "hash", "cust", { ...context, policyId: "q" }, "me"), "mismatch", "another policy");
    assert.equal(store.spentBy(review.id, "hash", "cust", { ...context, policyFingerprint: "new-rules" }, "me"), "policy_changed");
    openSqliteDatabase(db.path).prepare("UPDATE pending_reviews SET resolved_at = ? WHERE id = ?").run(new Date(Date.now() - 60 * 60_000).toISOString(), review.id);
    assert.equal(store.spentBy(review.id, "hash", "cust", context, "me"), "stale", "freshness still applies");

    // Given back after a refused vote: no longer spent by anyone.
    store.releaseConsumed(review.id);
    assert.equal(store.get(review.id)?.consumedBy, undefined);
    // Spent without naming a caller, as /gate-and-sign and every approval spent before this column existed: nobody can claim it.
    openSqliteDatabase(db.path).prepare("UPDATE pending_reviews SET resolved_at = ?, consumed_at = ? WHERE id = ?").run(new Date().toISOString(), new Date().toISOString(), review.id);
    assert.equal(store.spentBy(review.id, "hash", "cust", context, "me"), "consumed_elsewhere", "legacy spends fail closed");
  } finally { db.cleanup(); }
});

function fakeKora(signer: string, state: { calls: number }) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rpc = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      if (rpc.method === "getPayerSigner") return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signer_address: signer, payment_address: signer } }));
      state.calls += 1;
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signature: `sig-${state.calls}`, signed_transaction: "x", signer_pubkey: signer } }));
    });
  });
}

function reviewedTx(feePayer: PublicKey): string {
  const agent = Keypair.generate();
  const message = new TransactionMessage({ payerKey: feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 50_000_000 })] }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([agent]);
  return Buffer.from(tx.serialize()).toString("base64");
}

test("solana gate-and-sign: an approval is void once the policy's rules change, and good again only under the reviewed rules", async () => {
  const feePayer = Keypair.generate();
  const kora = { calls: 0 };
  const koraServer = await listen(fakeKora(feePayer.publicKey.toBase58(), kora));
  const original = buildDemoPolicy([Keypair.generate().publicKey.toBase58()]);
  const policies = new Map([["demo", original]]);
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder", reviewActionSecret: SECRET, koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${koraServer.port}` }) },
    auditLog: { append: (_c: string | undefined, type: string, data: Record<string, unknown>) => { events.push({ type, data }); }, list: () => [], verify: () => ({ ok: true }) } as any
  });
  const server = await listen(http.createServer(app));
  const base = `http://localhost:${server.port}`;
  const sign = async (tx: string, reviewId?: string, agentId = "a") => {
    const r = await fetch(`${base}/gate-and-sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, policyId: "demo", transactionBase64: tx, reviewId }) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    const tx = reviewedTx(feePayer.publicKey);
    const opened = await sign(tx);
    assert.equal(opened.body.decision, "NEEDS_REVIEW");
    assert.equal(opened.body.policyFingerprint, policyFingerprint(original), "the response names the reviewed revision");
    const shown = await (await fetch(`${base}/reviews/${opened.body.reviewId}`)).json() as any;
    assert.equal(shown.policyFingerprint, policyFingerprint(original));
    assert.equal(events.find((e) => e.type === "review_opened")?.data.policyFingerprint, policyFingerprint(original), "and so does the audit trail");
    const page = await readReview(base, opened.body.reviewId, { secret: SECRET }) as unknown as { policyFingerprint: string; currentPolicy: string };
    assert.deepEqual([page.policyFingerprint, page.currentPolicy], [policyFingerprint(original), "matches"], "and the review page, once signed in");
    await fetch(`${base}/review/${opened.body.reviewId}/approve`, { method: "POST", redirect: "manual", headers: { "x-review-action-secret": SECRET } });

    // Same policy id, a higher daily limit: still a review case, but not the rules the person saw.
    policies.set("demo", { ...original, maxAmountPerDay: { ...original.maxAmountPerDay, native: "999999999999" } });
    const changed = await sign(tx, opened.body.reviewId);
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.equal(changed.body.error, "REVIEW_POLICY_CHANGED");
    assert.equal(events.at(-1)?.type, "approval_refused");
    assert.equal(events.at(-1)?.data.reason, "policy_changed");

    assert.equal((await sign(reviewedTx(feePayer.publicKey), opened.body.reviewId)).body.error, "REVIEW_MISMATCH", "another transaction");
    assert.equal((await sign(tx, opened.body.reviewId, "other-agent")).body.error, "REVIEW_MISMATCH", "another agent");
    assert.equal(kora.calls, 0, "nothing was signed");

    policies.set("demo", { ...original }); // back to exactly the reviewed rules
    const right = await sign(tx, opened.body.reviewId);
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.equal(kora.calls, 1);
  } finally { await server.close(); await koraServer.close(); }
});

const ETH = 10n ** 18n;
const GWEI = 10n ** 9n;
const signer = new LocalKeySigner(Uint8Array.from(Buffer.from("3342460a1ac7dc070dfa35508ff134dfa8664edd4ce80e7f112e43cc118ba87e", "hex")));

test("evm gate-and-sign: an approval is void once the policy's rules change, and cannot be used by another customer", async () => {
  const customers = new CustomerStore();
  const acme = customers.create("acme");
  const rules = { policyId: "acme-evm", programAllowlist: ["evm:native"], destinationAllowlist: ["0x2222222222222222222222222222222222222222"], maxAmountPerTransaction: { native: String(ETH), "evm:gas": String(ETH / 100n) }, maxAmountPerDay: { native: String(10n * ETH), "evm:gas": String(3n * ETH / 100n) }, allowedChainIds: [1] };
  customers.setPolicy(acme.id, rules);
  const globex = customers.create("globex");
  customers.setPolicy(globex.id, { ...rules, policyId: "globex-evm" });
  const keys = { acme: customers.issueKey(acme.id).apiKey, globex: customers.issueKey(globex.id).apiKey };
  const app = createServer(new Map(), buildDemoRegistry(), { baseUrl: "http://placeholder", reviewActionSecret: SECRET, customers, reviewers: new ReviewerStore(), evmSigner: signer });
  const server = await listen(http.createServer(app));
  const base = `http://localhost:${server.port}`;
  const sign = async (key: string, policyId: string, reviewId?: string) => {
    const transaction = { chainId: 1, from: signer.address, to: "0x3333333333333333333333333333333333333333", value: String(ETH / 2n), nonce: "0", gasLimit: "100000", maxFeePerGas: String(50n * GWEI), maxPriorityFeePerGas: String(2n * GWEI) };
    const r = await fetch(`${base}/gate-and-sign-evm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ agentId: "a1", policyId, transaction, reviewId }) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    const opened = await sign(keys.acme, "acme-evm");
    assert.equal(opened.body.decision, "NEEDS_REVIEW");
    await fetch(`${base}/review/${opened.body.reviewId}/approve`, { method: "POST", redirect: "manual", headers: { "x-review-action-secret": SECRET } });

    customers.setPolicy(acme.id, { ...rules, maxAmountPerDay: { ...rules.maxAmountPerDay, native: String(20n * ETH) } });
    const changed = await sign(keys.acme, "acme-evm", opened.body.reviewId);
    assert.equal(changed.status, 409);
    assert.equal(changed.body.error, "REVIEW_POLICY_CHANGED");
    assert.equal((await sign(keys.globex, "globex-evm", opened.body.reviewId)).status, 404, "another customer's review looks missing");

    customers.setPolicy(acme.id, rules);
    const right = await sign(keys.acme, "acme-evm", opened.body.reviewId);
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.ok(right.body.signedTransaction);
  } finally { await server.close(); }
});
