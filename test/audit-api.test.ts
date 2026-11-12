import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { AuditLog, type AuditEventType } from "../src/observability/audit-log.js";
import { buildDemoRegistry } from "../demo/policy.js";

const SOL = 1_000_000_000;
const listen = (server: http.Server) => new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
  server.listen(0, () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) })));

interface Options { relayer?: "ok" | "down"; feePayerMismatch?: boolean; auditLog?: AuditLog; persistencePath?: string; customers?: CustomerStore; reviewers?: ReviewerStore }

async function setup(options: Options = {}) {
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
      const signer = options.feePayerMismatch ? Keypair.generate().publicKey : feePayer.publicKey;
      if (rpc.method === "getPayerSigner") return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signer_address: signer.toBase58(), payment_address: signer.toBase58() } }));
      if (options.relayer === "down") return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", error: { code: -32000, message: "relayer down" } }));
      state.signed += 1;
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signature: `sig-${state.signed}`, signed_transaction: "x", signer_pubkey: feePayer.publicKey.toBase58() } }));
    });
  }));
  const customers = options.customers ?? new CustomerStore({ persistencePath: options.persistencePath });
  const reviewers = options.reviewers ?? new ReviewerStore({ persistencePath: options.persistencePath });
  const policyOf = new Map<string, string>();
  const makeCustomer = (name: string) => {
    const c = customers.create(name, 100_000);
    customers.setPolicy(c.id, { policyId: `pay-${name}`, programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [vendor.toBase58()], maxAmountPerTransaction: { native: String(1 * SOL) }, maxAmountPerDay: { native: String(100 * SOL) } });
    const apiKey = customers.issueKey(c.id).apiKey;
    policyOf.set(apiKey, `pay-${name}`);
    return { id: c.id, apiKey, reviewerToken: reviewers.create(`${name}-reviewer`, c.id).token };
  };
  const app = createServer(new Map(), buildDemoRegistry(), {
    baseUrl: "http://placeholder", customers, reviewers, persistencePath: options.persistencePath, auditLog: options.auditLog,
    rateLimit: { maxRequests: 100_000, windowMs: 60_000 }, koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${kora.port}` }) }
  });
  const server = await listen(http.createServer(app));
  const base = `http://localhost:${server.port}`;
  const tx = (lamports: number, extra: ReturnType<typeof SystemProgram.transfer>[] = []) => Buffer.from(new VersionedTransaction(new TransactionMessage({
    payerKey: feePayer.publicKey, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: agent, toPubkey: vendor, lamports }), ...extra]
  }).compileToV0Message()).serialize()).toString("base64");
  const hidden = () => tx(250_000_000, [SystemProgram.assign({ accountPubkey: agent, programId: Keypair.generate().publicKey })]);
  const call = async (key: string, pathname: string, body?: unknown) => {
    const r = await fetch(base + pathname, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => undefined)) as any };
  };
  const send = (key: string, transactionBase64: string, extra: object = {}) => call(key, "/gate-and-sign", { agentId: "bot", policyId: policyOf.get(key), transactionBase64, ...extra });
  const approve = (reviewId: string, token: string) => fetch(`${base}/review/${reviewId}/approve`, { method: "POST", redirect: "manual", headers: { "x-reviewer-token": token } });
  return { base, state, makeCustomer, tx, hidden, call, send, approve, close: async () => { await server.close(); await kora.close(); } };
}

const types = (events: Array<{ type: string }>) => events.map((e) => e.type);

test("audit api: the whole story of a held payment is on record, in order, with who approved and what was signed", async () => {
  const t = await setup();
  try {
    const a = t.makeCustomer("acme");
    const allowed = await t.send(a.apiKey, t.tx(1000));
    assert.equal(allowed.status, 200);
    const hiddenTx = t.hidden();
    const held = await t.send(a.apiKey, hiddenTx);
    assert.equal(held.body.decision, "NEEDS_REVIEW");
    assert.equal((await t.approve(held.body.reviewId, a.reviewerToken)).status, 302);
    const released = await t.send(a.apiKey, hiddenTx, { reviewId: held.body.reviewId });
    assert.equal(released.status, 200);
    const reused = await t.send(a.apiKey, hiddenTx, { reviewId: held.body.reviewId });
    assert.equal(reused.status, 409);

    const log = await t.call(a.apiKey, "/audit");
    assert.equal(log.status, 200);
    const events = log.body.events;
    assert.deepEqual(types(events), ["evaluated", "signed", "evaluated", "review_opened", "review_resolved", "evaluated", "signed", "evaluated", "approval_refused"]);
    assert.deepEqual(events.map((e: any) => e.n), [1, 2, 3, 4, 5, 6, 7, 8, 9]);

    assert.equal(events[0].data.decision, "ALLOW");
    assert.equal(events[1].data.signature, "sig-1");
    assert.equal(events[2].data.decision, "NEEDS_REVIEW");
    assert.equal(events[3].data.reviewId, held.body.reviewId);
    assert.equal(events[4].data.status, "APPROVED");
    assert.equal(events[4].data.by, "acme-reviewer", "the approval is attributed to the named reviewer");
    assert.equal(events[6].data.signature, "sig-2");
    assert.equal(events[6].data.viaReview, held.body.reviewId, "the signature says which approval it spent");
    assert.equal(events[7].data.decision, "NEEDS_REVIEW");
    assert.equal(events[8].data.reason, "already_used");
    assert.equal(events[8].data.reviewId, held.body.reviewId);
    assert.equal(events[3].data.transactionHash, events[6].data.transactionHash, "the review and the signature refer to the same transaction");

    const verified = await t.call(a.apiKey, "/audit/verify");
    assert.deepEqual({ ok: verified.body.ok, events: verified.body.events, headHash: verified.body.headHash }, { ok: true, events: 9, headHash: events[8].hash });
  } finally { await t.close(); }
});

test("audit api: customers see only their own trail, and paging and bad input behave", async () => {
  const t = await setup();
  try {
    const a = t.makeCustomer("acme");
    const b = t.makeCustomer("beta");
    for (let i = 0; i < 3; i++) await t.send(a.apiKey, t.tx(1000 + i));
    await t.send(b.apiKey, t.tx(5));

    assert.equal((await t.call(a.apiKey, "/audit")).body.events.length, 6);
    const bLog = await t.call(b.apiKey, "/audit");
    assert.equal(bLog.body.events.length, 2);
    assert.ok(bLog.body.events.every((e: any) => e.scope === b.id));

    const page1 = await t.call(a.apiKey, "/audit?limit=4");
    assert.deepEqual(page1.body.events.map((e: any) => e.n), [1, 2, 3, 4]);
    assert.equal(page1.body.next, 4);
    const page2 = await t.call(a.apiKey, `/audit?after=${page1.body.next}&limit=4`);
    assert.deepEqual(page2.body.events.map((e: any) => e.n), [5, 6]);
    assert.equal((await t.call(a.apiKey, "/audit?after=99")).body.events.length, 0);

    for (const bad of ["after=-1", "limit=abc", "after=1.5", "limit=", "after=99999999999"]) assert.equal((await t.call(a.apiKey, `/audit?${bad}`)).status, 400, bad);
    const noKey = await fetch(`${t.base}/audit`);
    assert.equal(noKey.status, 401);
    assert.equal((await t.call(b.apiKey, "/audit/verify")).body.ok, true);
  } finally { await t.close(); }
});

test("audit api: the trail survives a restart, and holds no keys or tokens", async () => {
  const dbPath = path.join(mkdtempSync(path.join(tmpdir(), "audit-api-")), "db.sqlite");
  const first = await setup({ persistencePath: dbPath });
  const a = first.makeCustomer("acme");
  const hiddenTx = first.hidden();
  const held = await first.send(a.apiKey, hiddenTx);
  await first.approve(held.body.reviewId, a.reviewerToken);
  await first.send(a.apiKey, hiddenTx, { reviewId: held.body.reviewId });
  const before = (await first.call(a.apiKey, "/audit")).body.events;
  const headBefore = (await first.call(a.apiKey, "/audit/verify")).body.headHash;
  await first.close();

  const second = await setup({ persistencePath: dbPath, customers: new CustomerStore({ persistencePath: dbPath }), reviewers: new ReviewerStore({ persistencePath: dbPath }) });
  try {
    const after = (await second.call(a.apiKey, "/audit")).body.events;
    assert.deepEqual(after, before, "the same events come back after a restart");
    assert.equal((await second.call(a.apiKey, "/audit/verify")).body.headHash, headBefore);
    const more = await second.call(a.apiKey, "/gate-and-sign", { agentId: "bot", policyId: "pay-acme", transactionBase64: second.tx(1) });
    assert.equal(more.status, 200, "the restarted server still serves the customer's persisted policy");
    const extended = (await second.call(a.apiKey, "/audit")).body.events;
    assert.ok(extended.length > after.length, "new events were added after the restart");
    assert.deepEqual(extended.map((e: any) => e.n), extended.map((_: unknown, i: number) => i + 1), "positions continue without a gap");
    assert.equal(extended[after.length].prevHash, after.at(-1).hash, "the first new event links to the last old one");
    assert.equal((await second.call(a.apiKey, "/audit/verify")).body.ok, true);
    const everything = JSON.stringify((await second.call(a.apiKey, "/audit")).body);
    assert.ok(!everything.includes(a.apiKey) && !everything.includes("agk_"), "no API key in the trail");
    assert.ok(!everything.includes(a.reviewerToken), "no reviewer token in the trail");
  } finally { await second.close(); }
});

test("audit api: failed signing is recorded with whether the outcome is known", async () => {
  const down = await setup({ relayer: "down" });
  try {
    const a = down.makeCustomer("acme");
    assert.equal((await down.send(a.apiKey, down.tx(1000))).status, 502);
    const failed = (await down.call(a.apiKey, "/audit")).body.events.find((e: any) => e.type === "signing_failed");
    assert.equal(failed.data.outcome, "UNKNOWN", "a relayer error may have come after broadcast");
    assert.equal(failed.data.code, "KORA_SIGNING_FAILED");
  } finally { await down.close(); }

  const mismatch = await setup({ feePayerMismatch: true });
  try {
    const a = mismatch.makeCustomer("acme");
    assert.equal((await mismatch.send(a.apiKey, mismatch.tx(1000))).status, 400);
    const failed = (await mismatch.call(a.apiKey, "/audit")).body.events.find((e: any) => e.type === "signing_failed");
    assert.equal(failed.data.outcome, "NOT_SENT", "refused before anything was sent");
    assert.equal(failed.data.code, "KORA_FEE_PAYER_MISMATCH");
  } finally { await mismatch.close(); }
});

/** An audit log that fails on chosen event types, to test what the server does when it cannot write. */
class FailingAudit extends AuditLog {
  constructor(private readonly failOn: AuditEventType) { super(); }
  override append(customerId: string | undefined, type: AuditEventType, data: Record<string, unknown>) {
    if (type === this.failOn) throw new Error("disk full");
    return super.append(customerId, type, data);
  }
}

test("audit api: if the record before an action cannot be written nothing is signed; if the record after a signature fails the signature is still returned", async () => {
  const before = await setup({ auditLog: new FailingAudit("evaluated") });
  try {
    const a = before.makeCustomer("acme");
    const r = await before.send(a.apiKey, before.tx(1000));
    assert.equal(r.status, 500);
    assert.equal(before.state.signed, 0, "no signature without a record");
  } finally { await before.close(); }

  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  const after = await setup({ auditLog: new FailingAudit("signed") });
  try {
    const a = after.makeCustomer("acme");
    const r = await after.send(a.apiKey, after.tx(1000));
    assert.equal(r.status, 200);
    assert.equal(r.body.kora.signature, "sig-1", "the caller still gets the signature that exists");
    assert.ok(errors.some((e) => String(e[0]).includes("AUDIT WRITE FAILED after signing") && String(e[1]).includes("sig-1")), "the lost event is reported loudly, with the signature");
  } finally { console.error = original; await after.close(); }
});
