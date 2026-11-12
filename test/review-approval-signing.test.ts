import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer, type ServerConfig } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";

const SECRET = "test-secret";
const listen = (server: http.Server) => new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
  server.listen(0, () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) })));

function fakeKora(signer: string, state: { fail: boolean; calls: number }) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rpc = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      if (rpc.method === "getPayerSigner") return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signer_address: signer, payment_address: signer } }));
      state.calls += 1;
      if (state.fail) return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", error: { code: -32000, message: "signer unavailable" } }));
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signature: `sig-${state.calls}`, signed_transaction: "x", signer_pubkey: signer } }));
    });
  });
}

// A transfer to a destination outside the vendor allowlist: always NEEDS_REVIEW under the demo policy.
function unapprovedTx(feePayer: PublicKey, lamports = 50_000_000): string {
  const agent = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: feePayer, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: Keypair.generate().publicKey, lamports })]
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([agent]);
  return Buffer.from(tx.serialize()).toString("base64");
}

async function setup(options: Partial<ServerConfig> = {}) {
  const feePayer = Keypair.generate();
  const state = { fail: false, calls: 0 };
  const kora = await listen(fakeKora(feePayer.publicKey.toBase58(), state));
  const app = createServer(new Map([["demo", buildDemoPolicy([Keypair.generate().publicKey.toBase58()])]]), buildDemoRegistry(), {
    baseUrl: "http://placeholder", reviewActionSecret: SECRET,
    koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${kora.port}` }) }, ...options
  });
  const server = await listen(http.createServer(app));
  const baseUrl = `http://localhost:${server.port}`;
  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const sign = (tx: string, reviewId?: string, headers?: Record<string, string>) => post("/gate-and-sign", { agentId: "a", policyId: "demo", transactionBase64: tx, reviewId }, headers);
  const decide = (id: string, action: "approve" | "deny") => fetch(`${baseUrl}/review/${id}/${action}`, { method: "POST", redirect: "manual", headers: { "x-review-action-secret": SECRET } });
  return { feePayer: feePayer.publicKey, state, baseUrl, post, sign, decide, close: async () => { await server.close(); await kora.close(); } };
}

test("an approved review signs exactly that transaction, once", async () => {
  const t = await setup();
  try {
    const tx = unapprovedTx(t.feePayer);
    const first = await t.sign(tx);
    assert.equal(first.body.decision, "NEEDS_REVIEW");
    assert.equal(t.state.calls, 0, "nothing signed before approval");
    assert.equal((await t.decide(first.body.reviewId, "approve")).status, 302);

    const signed = await t.sign(tx, first.body.reviewId);
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.kora.signature, "sig-1");
    const again = await t.sign(tx, first.body.reviewId);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "REVIEW_ALREADY_USED");
    assert.equal(t.state.calls, 1, "an approval is single use");
  } finally { await t.close(); }
});

test("pending, denied and unknown reviews cannot sign", async () => {
  const t = await setup();
  try {
    const tx = unapprovedTx(t.feePayer);
    const { body } = await t.sign(tx);
    assert.equal((await t.sign(tx, body.reviewId)).body.error, "REVIEW_NOT_APPROVED");
    await t.decide(body.reviewId, "deny");
    assert.equal((await t.sign(tx, body.reviewId)).body.error, "REVIEW_NOT_APPROVED");
    assert.equal((await t.sign(tx, "no-such-review")).status, 404);
    assert.equal(t.state.calls, 0);
  } finally { await t.close(); }
});

test("an approval for one transaction cannot sign a different one", async () => {
  const t = await setup();
  try {
    const reviewed = unapprovedTx(t.feePayer, 50_000_000);
    const swapped = unapprovedTx(t.feePayer, 50_000_001); // different destination and amount
    const { body } = await t.sign(reviewed);
    await t.decide(body.reviewId, "approve");
    const attempt = await t.sign(swapped, body.reviewId);
    assert.equal(attempt.status, 400);
    assert.equal(attempt.body.error, "REVIEW_MISMATCH");
    assert.equal(t.state.calls, 0);
    assert.equal((await t.sign(reviewed, body.reviewId)).status, 200, "the reviewed transaction still works");
  } finally { await t.close(); }
});

test("two simultaneous uses of one approval sign once", async () => {
  const t = await setup();
  try {
    const tx = unapprovedTx(t.feePayer);
    const { body } = await t.sign(tx);
    await t.decide(body.reviewId, "approve");
    const results = await Promise.all(Array.from({ length: 6 }, () => t.sign(tx, body.reviewId)));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(t.state.calls, 1);
  } finally { await t.close(); }
});

test("if signing fails the approval is given back, so a retry can succeed", async () => {
  const t = await setup();
  try {
    const tx = unapprovedTx(t.feePayer);
    const { body } = await t.sign(tx);
    await t.decide(body.reviewId, "approve");
    t.state.fail = true;
    assert.equal((await t.sign(tx, body.reviewId)).status, 502);
    t.state.fail = false;
    assert.equal((await t.sign(tx, body.reviewId)).status, 200);
  } finally { await t.close(); }
});

test("an approval goes stale after the review window", async () => {
  const t = await setup({ reviewExpiryMs: 900 });
  try {
    const tx = unapprovedTx(t.feePayer);
    const { body } = await t.sign(tx);
    await t.decide(body.reviewId, "approve");
    await new Promise((r) => setTimeout(r, 1000));
    const attempt = await t.sign(tx, body.reviewId);
    assert.equal(attempt.status, 409);
    assert.equal(attempt.body.error, "REVIEW_STALE");
  } finally { await t.close(); }
});

test("GET /reviews/:id tells an agent the outcome without exposing the transaction", async () => {
  const reviewers = new ReviewerStore();
  const alice = reviewers.create("Alice");
  const t = await setup({ reviewers });
  try {
    const { body } = await t.sign(unapprovedTx(t.feePayer));
    const get = async () => (await (await fetch(`${t.baseUrl}/reviews/${body.reviewId}`)).json()) as any;
    assert.equal((await get()).status, "PENDING");
    await fetch(`${t.baseUrl}/review/${body.reviewId}/approve`, { method: "POST", redirect: "manual", headers: { "x-reviewer-token": alice.token } });
    const after = await get();
    assert.equal(after.status, "APPROVED");
    assert.equal(after.resolvedBy, "Alice");
    assert.equal(after.used, false);
    assert.ok(!JSON.stringify(after).includes("transaction"), "no transaction data in the status response");
    assert.equal((await fetch(`${t.baseUrl}/reviews/no-such`)).status, 404);
  } finally { await t.close(); }
});

test("with customers, reviews and approvals are private to the customer that created them", async () => {
  const customers = new CustomerStore();
  const make = (name: string) => {
    const c = customers.create(name);
    customers.setPolicy(c.id, { policyId: `${name}-pay`, programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [Keypair.generate().publicKey.toBase58()], maxAmountPerTransaction: { native: "1000000000" }, maxAmountPerDay: { native: "5000000000" } });
    return { policyId: `${name}-pay`, headers: { authorization: `Bearer ${customers.issueKey(c.id).apiKey}` } };
  };
  const acme = make("acme");
  const globex = make("globex");
  const t = await setup({ customers });
  try {
    const tx = unapprovedTx(t.feePayer);
    const created = await t.post("/gate-and-sign", { agentId: "a", policyId: acme.policyId, transactionBase64: tx }, acme.headers);
    assert.equal(created.body.decision, "NEEDS_REVIEW");
    await t.decide(created.body.reviewId, "approve");

    const get = (headers: Record<string, string>) => fetch(`${t.baseUrl}/reviews/${created.body.reviewId}`, { headers });
    assert.equal((await get(acme.headers)).status, 200);
    assert.equal((await get(globex.headers)).status, 404, "another customer cannot see the review");
    const stolen = await t.post("/gate-and-sign", { agentId: "a", policyId: globex.policyId, transactionBase64: tx, reviewId: created.body.reviewId }, globex.headers);
    assert.equal(stolen.status, 404, "another customer cannot spend the approval");
    assert.equal(t.state.calls, 0);
    const own = await t.post("/gate-and-sign", { agentId: "a", policyId: acme.policyId, transactionBase64: tx, reviewId: created.body.reviewId }, acme.headers);
    assert.equal(own.status, 200, JSON.stringify(own.body));
  } finally { await t.close(); }
});

test("the message hash ignores signatures, differs per message, and handles legacy, v0 and v1", async () => {
  const { transactionMessageHash } = await import("../src/gateway/message-hash.js");
  const payer = Keypair.generate();
  const to = Keypair.generate().publicKey;
  const build = (version: "legacy" | 0, signer: Keypair, lamports = 5) => {
    const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports })] });
    const tx = new VersionedTransaction(version === 0 ? message.compileToV0Message() : message.compileToLegacyMessage());
    tx.sign([signer]);
    return Buffer.from(tx.serialize()).toString("base64");
  };
  for (const version of ["legacy", 0] as const) {
    const unsigned = build(version, payer);
    const bytes = Buffer.from(unsigned, "base64");
    bytes[5] ^= 0xff; // corrupt a signature byte
    assert.equal(transactionMessageHash(bytes.toString("base64")), transactionMessageHash(unsigned), `${version}: signature bytes must not matter`);
    assert.notEqual(transactionMessageHash(build(version, payer, 6)), transactionMessageHash(unsigned), `${version}: different message, different hash`);
  }
  // A real mainnet v1 transaction: message first, signature last.
  const v1 = "gQEAAgwAAAAqpv2X2he/XHBdhLTzmbPZ+D2lN8oyyyIQ16Nwif38dwEEs8oqmvYGvPMwEp9+d0kzO4ee6EwcRdDtMvjFu5qEJp/xh+yH0fdFyzoDOEompp7aDKLRqg9B5CQWN36R/1tdMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7yQ4K2z3gnrDjF1dcZZwuUuXenG2C1zj0tqjI9me77GWAAAAACAAAAICDAAAAQIAAAAXBwAAAAAAAN8ZgEl0JZiHjp3BYh/NcKZH8tFGkn5vPRdPU/zuTZ9WoMi3KfR/Zfs5MrQvbsQUOyJKZdiiPFxT+p3idiT4FQo=";
  const raw = Buffer.from(v1, "base64");
  const expected = (await import("node:crypto")).createHash("sha256").update(raw.subarray(0, raw.length - 64)).digest("hex");
  assert.equal(transactionMessageHash(v1), expected);
  const resigned = Buffer.from(raw); resigned[raw.length - 1] ^= 0xff;
  assert.equal(transactionMessageHash(resigned.toString("base64")), expected, "v1: signature bytes must not matter");
  assert.equal(transactionMessageHash("not a transaction"), undefined);
  assert.equal(transactionMessageHash(""), undefined);
});

test("an unexpected error returns a 500 instead of hanging, and signs nothing", async () => {
  class BrokenCustomers extends CustomerStore {
    override getPolicy(): never { throw new Error("database exploded: secret detail"); }
  }
  const customers = new BrokenCustomers();
  const c = customers.create("Acme");
  const { apiKey } = customers.issueKey(c.id);
  const t = await setup({ customers });
  try {
    const response = await Promise.race([
      t.post("/gate-and-sign", { agentId: "a", policyId: "x", transactionBase64: unapprovedTx(t.feePayer) }, { authorization: `Bearer ${apiKey}` }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("request hung")), 5000))
    ]);
    assert.equal(response.status, 500);
    assert.equal(response.body.error, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(response.body).includes("secret detail"), "internal error text must not leak");
    assert.equal(t.state.calls, 0);
  } finally { await t.close(); }
});

test("budget: a certain failure refunds it, an unknown outcome keeps it, a preview never spends it", async () => {
  // Cap of 100 lamports a day; each transfer below is 60, so two charged transfers would exceed it.
  const feePayer = Keypair.generate();
  const state = { fail: false, calls: 0 };
  const kora = await listen(fakeKora(feePayer.publicKey.toBase58(), state));
  const vendor = Keypair.generate().publicKey;
  const policy = { ...buildDemoPolicy([vendor.toBase58()], "1000", "100") };
  const app = createServer(new Map([["demo", policy]]), buildDemoRegistry(), {
    baseUrl: "http://placeholder", reviewActionSecret: SECRET,
    koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${kora.port}` }) }
  });
  const server = await listen(http.createServer(app));
  const call = async (path: string, body: object) => {
    const r = await fetch(`http://localhost:${server.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "a", policyId: "demo", ...body }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const toVendor = (lamports: number, payer: PublicKey = feePayer.publicKey) => {
    const agent = Keypair.generate();
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: vendor, lamports })] }).compileToV0Message();
    const tx = new VersionedTransaction(message); tx.sign([agent]);
    return Buffer.from(tx.serialize()).toString("base64");
  };
  try {
    // Previews spend nothing, however many are made.
    for (let i = 0; i < 3; i++) assert.equal((await call("/evaluate", { transactionBase64: toVendor(60) })).body.decision, "ALLOW");
    // A certain failure (wrong fee payer, caught before anything is sent) refunds the budget.
    assert.equal((await call("/gate-and-sign", { transactionBase64: toVendor(60, Keypair.generate().publicKey) })).status, 400);
    assert.equal((await call("/evaluate", { transactionBase64: toVendor(60) })).body.decision, "ALLOW", "the refunded 60 is available again");
    // An unknown outcome (Kora errored; it may have broadcast) keeps the budget reserved.
    state.fail = true;
    const unknown = await call("/gate-and-sign", { transactionBase64: toVendor(60) });
    assert.equal(unknown.status, 502);
    assert.equal(unknown.body.outcome, "UNKNOWN");
    assert.equal((await call("/evaluate", { transactionBase64: toVendor(60) })).body.decision, "NEEDS_REVIEW", "60 stays charged: over-counting is safe, handing money back that may have moved is not");
    // reserve:true charges, so callers who sign elsewhere can still enforce the cap.
    state.fail = false;
    assert.equal((await call("/evaluate", { transactionBase64: toVendor(30), reserve: true })).body.decision, "ALLOW");
    assert.equal((await call("/evaluate", { transactionBase64: toVendor(30), reserve: true })).body.decision, "NEEDS_REVIEW", "60 + 30 + 30 > 100");
  } finally { await server.close(); await kora.close(); }

  const t = await setup();
  try {
    const tx = unapprovedTx(t.feePayer);
    const { body } = await t.sign(tx);
    await t.decide(body.reviewId, "approve");
    assert.equal((await t.sign(tx, body.reviewId)).body.signedViaReview, body.reviewId);
  } finally { await t.close(); }
});

test("a refund goes back to the day it was charged to, not to today", async () => {
  const { DailySpendTracker } = await import("../src/policy/daily-spend-tracker.js");
  const RealDate = Date;
  let now = new RealDate("2026-10-19T23:59:50Z").getTime();
  const Fake = class extends RealDate { constructor(...args: any[]) { super(args.length ? (args[0] as number) : now); } static override now() { return now; } };
  globalThis.Date = Fake as unknown as DateConstructor;
  try {
    const tracker = new DailySpendTracker();
    const yesterday = tracker.record("p", { native: 60n }); // charged on 19 Oct
    now = new RealDate("2026-10-20T00:00:05Z").getTime();
    tracker.record("p", { native: 70n });                   // real spend on 20 Oct
    tracker.release(yesterday);                              // yesterday's reservation is refunded
    assert.equal(tracker.spentToday("p").native, 70n, "20 Oct still shows its full 70");
  } finally { globalThis.Date = RealDate; }
});

test("an approval opened under one policy or agent cannot be used under another", async () => {
  const feePayer = Keypair.generate();
  const state = { fail: false, calls: 0 };
  const kora = await listen(fakeKora(feePayer.publicKey.toBase58(), state));
  // Two policies that both send this transfer to review.
  const policies = new Map([
    ["strict", { ...buildDemoPolicy([Keypair.generate().publicKey.toBase58()]), policyId: "strict" }],
    ["loose", { ...buildDemoPolicy([Keypair.generate().publicKey.toBase58()]), policyId: "loose" }]
  ]);
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder", reviewActionSecret: SECRET, koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${kora.port}` }) } });
  const server = await listen(http.createServer(app));
  const base = `http://localhost:${server.port}`;
  const sign = async (agentId: string, policyId: string, tx: string, reviewId?: string) => {
    const r = await fetch(`${base}/gate-and-sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId, policyId, transactionBase64: tx, reviewId }) });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    const tx = unapprovedTx(feePayer.publicKey);
    const opened = await sign("agent-1", "strict", tx);
    assert.equal(opened.body.decision, "NEEDS_REVIEW");
    await fetch(`${base}/review/${opened.body.reviewId}/approve`, { method: "POST", redirect: "manual", headers: { "x-review-action-secret": SECRET } });

    const otherPolicy = await sign("agent-1", "loose", tx, opened.body.reviewId);
    assert.equal(otherPolicy.body.error, "REVIEW_MISMATCH", JSON.stringify(otherPolicy.body));
    const otherAgent = await sign("agent-2", "strict", tx, opened.body.reviewId);
    assert.equal(otherAgent.body.error, "REVIEW_MISMATCH", JSON.stringify(otherAgent.body));
    assert.equal(state.calls, 0, "nothing was signed under the wrong policy or agent");

    const right = await sign("agent-1", "strict", tx, opened.body.reviewId);
    assert.equal(right.status, 200, JSON.stringify(right.body));
    assert.equal(state.calls, 1);
  } finally {
    await server.close();
    await kora.close();
  }
});
