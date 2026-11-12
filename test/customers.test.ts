import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createServer, type ServerConfig } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";

function transferTx(lamports = 1000): string {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports })]
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

const policyFor = (policyId: string, perTx = "1000000000") => ({
  policyId,
  programAllowlist: [SystemProgram.programId.toBase58()],
  destinationAllowlist: [], allowAnyDestination: true,
  maxAmountPerTransaction: { native: perTx },
  maxAmountPerDay: { native: "5000000000" }
});

async function startApp(options: Partial<ServerConfig>) {
  const app = createServer(new Map([["demo", buildDemoPolicy()]]), buildDemoRegistry(), { baseUrl: "http://placeholder", ...options });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}

function evaluate(baseUrl: string, key: string | undefined, policyId: string, agentId = "agent-1", via: "bearer" | "x-api-key" = "bearer") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers[via === "bearer" ? "authorization" : "x-api-key"] = via === "bearer" ? `Bearer ${key}` : key;
  return fetch(`${baseUrl}/evaluate`, { method: "POST", headers, body: JSON.stringify({ agentId, policyId, transactionBase64: transferTx() }) });
}

function onboard(store: CustomerStore, name: string, policyId: string, perTx?: string, rate?: number) {
  const customer = store.create(name, rate);
  store.setPolicy(customer.id, policyFor(policyId, perTx));
  return { customer, ...store.issueKey(customer.id) };
}

test("open mode is unchanged until the first customer exists, then every transaction endpoint needs a key", async () => {
  const store = new CustomerStore();
  const app = await startApp({ customers: store });
  try {
    assert.equal((await evaluate(app.baseUrl, undefined, "demo")).status, 200, "open mode");
    onboard(store, "Acme", "acme-pay");
    assert.equal((await evaluate(app.baseUrl, undefined, "demo")).status, 401, "customers exist now, no key");
    assert.equal((await fetch(`${app.baseUrl}/agents/agent-1/history`)).status, 401, "history is protected too");
    assert.equal((await fetch(`${app.baseUrl}/healthz`)).status, 200, "health stays open");
  } finally { await app.close(); }
});

test("a valid key works via Authorization and X-API-Key; wrong, malformed and revoked keys are rejected", async () => {
  const store = new CustomerStore();
  const acme = onboard(store, "Acme", "acme-pay");
  const app = await startApp({ customers: store });
  try {
    assert.equal((await evaluate(app.baseUrl, acme.apiKey, "acme-pay")).status, 200);
    assert.equal((await evaluate(app.baseUrl, acme.apiKey, "acme-pay", "a", "x-api-key")).status, 200);
    assert.equal((await evaluate(app.baseUrl, acme.apiKey + "x", "acme-pay")).status, 401);
    assert.equal((await evaluate(app.baseUrl, "agk_" + "A".repeat(43), "acme-pay")).status, 401);
    assert.equal((await evaluate(app.baseUrl, "not-a-key", "acme-pay")).status, 401);
    store.revokeKey(acme.keyId);
    assert.equal((await evaluate(app.baseUrl, acme.apiKey, "acme-pay")).status, 401, "revoked key");
  } finally { await app.close(); }
});

test("revoking the only customer does not reopen the endpoints", async () => {
  const store = new CustomerStore();
  const acme = onboard(store, "Acme", "acme-pay");
  const app = await startApp({ customers: store });
  try {
    assert.equal((await evaluate(app.baseUrl, acme.apiKey, "acme-pay")).status, 200);
    store.revoke(acme.customer.id);
    assert.equal((await evaluate(app.baseUrl, acme.apiKey, "acme-pay")).status, 401);
    assert.equal((await evaluate(app.baseUrl, undefined, "demo")).status, 401, "still closed, not open mode");
  } finally { await app.close(); }
});

test("requireApiKeys rejects everything even before the first customer exists", async () => {
  const app = await startApp({ customers: new CustomerStore(), requireApiKeys: true });
  try {
    assert.equal((await evaluate(app.baseUrl, undefined, "demo")).status, 401);
  } finally { await app.close(); }
});

test("a customer cannot use another customer's policy, or the built-in one, and cannot tell them apart from a missing one", async () => {
  const store = new CustomerStore();
  const acme = onboard(store, "Acme", "acme-pay");
  const globex = onboard(store, "Globex", "globex-pay");
  const app = await startApp({ customers: store });
  try {
    assert.equal((await evaluate(app.baseUrl, acme.apiKey, "acme-pay")).status, 200);
    const cross = await evaluate(app.baseUrl, acme.apiKey, "globex-pay");
    const missing = await evaluate(app.baseUrl, acme.apiKey, "no-such-policy");
    const builtin = await evaluate(app.baseUrl, acme.apiKey, "demo");
    for (const response of [cross, missing, builtin]) assert.equal(response.status, 404);
    assert.deepEqual(await cross.json(), await missing.json());
    assert.equal((await evaluate(app.baseUrl, globex.apiKey, "globex-pay")).status, 200);
  } finally { await app.close(); }
});

test("history, summaries and single entries are scoped to the calling customer", async () => {
  const store = new CustomerStore();
  const acme = onboard(store, "Acme", "acme-pay");
  const globex = onboard(store, "Globex", "globex-pay");
  const app = await startApp({ customers: store });
  try {
    const mine = await (await evaluate(app.baseUrl, acme.apiKey, "acme-pay", "shared-agent-name")).json() as { logEntryId: string };
    const theirs = await (await evaluate(app.baseUrl, globex.apiKey, "globex-pay", "shared-agent-name")).json() as { logEntryId: string };
    const auth = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

    const history = await (await fetch(`${app.baseUrl}/agents/shared-agent-name/history`, auth(acme.apiKey))).json() as { summary: { total: number }; entries: Array<{ id: string }> };
    assert.equal(history.summary.total, 1);
    assert.deepEqual(history.entries.map((e) => e.id), [mine.logEntryId]);

    assert.equal((await fetch(`${app.baseUrl}/transactions/${mine.logEntryId}`, auth(acme.apiKey))).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/transactions/${theirs.logEntryId}`, auth(acme.apiKey))).status, 404, "another customer's entry");
  } finally { await app.close(); }
});

test("each customer's rate limit is its own, and one customer cannot exhaust another's", async () => {
  const store = new CustomerStore();
  const small = onboard(store, "Small", "small-pay", undefined, 2);
  const big = onboard(store, "Big", "big-pay", undefined, 50);
  const app = await startApp({ customers: store });
  try {
    assert.equal((await evaluate(app.baseUrl, small.apiKey, "small-pay")).status, 200);
    assert.equal((await evaluate(app.baseUrl, small.apiKey, "small-pay")).status, 200);
    assert.equal((await evaluate(app.baseUrl, small.apiKey, "small-pay")).status, 429);
    assert.equal((await evaluate(app.baseUrl, big.apiKey, "big-pay")).status, 200);
  } finally { await app.close(); }
});

test("bad-key attempts are rate limited per IP without touching valid customers", async () => {
  const store = new CustomerStore();
  const acme = onboard(store, "Acme", "acme-pay");
  const app = await startApp({ customers: store, rateLimit: { maxRequests: 3, windowMs: 60_000 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await evaluate(app.baseUrl, "agk_bad", "acme-pay")).status, 401);
    assert.equal((await evaluate(app.baseUrl, "agk_bad", "acme-pay")).status, 429);
    assert.equal((await evaluate(app.baseUrl, acme.apiKey, "acme-pay")).status, 200, "valid key unaffected by the failure budget");
  } finally { await app.close(); }
});

test("a customer's policy limits are enforced (over-limit goes to review)", async () => {
  const store = new CustomerStore();
  const tight = onboard(store, "Tight", "tight-pay", "500");
  const app = await startApp({ customers: store });
  try {
    const response = await fetch(`${app.baseUrl}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tight.apiKey}` },
      body: JSON.stringify({ agentId: "a", policyId: "tight-pay", transactionBase64: transferTx(1000) })
    });
    assert.equal(((await response.json()) as { decision: string }).decision, "NEEDS_REVIEW");
  } finally { await app.close(); }
});

test("policies are validated strictly and a policy id belongs to one customer", () => {
  const store = new CustomerStore();
  const a = store.create("A");
  const b = store.create("B");
  assert.throws(() => store.setPolicy(a.id, { ...policyFor("p1"), maxAmountPerTx: "1" }), /Unrecognized key/);
  assert.throws(() => store.setPolicy(a.id, { ...policyFor("p1"), maxAmountPerDay: { native: "-5" } }), /non-negative integer/);
  assert.throws(() => store.setPolicy(a.id, { ...policyFor("p1"), programAllowlist: ["not-an-address"] }), /valid base58/);
  assert.throws(() => store.setPolicy(a.id, policyFor("bad id!")), /policyId/);
  store.setPolicy(a.id, policyFor("p1"));
  assert.throws(() => store.setPolicy(b.id, policyFor("p1")), /already used by another customer/);
  store.setPolicy(a.id, policyFor("p1", "7")); // replacing your own is fine
  assert.equal(store.getPolicy(a.id, "p1")?.maxAmountPerTransaction.native, "7");
  assert.equal(store.getPolicy(b.id, "p1"), undefined);
});

test("keys are never stored in plaintext, and customers and keys survive a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-customers-"));
  const path = join(dir, "db.sqlite");
  try {
    const store = new CustomerStore({ persistencePath: path });
    const { apiKey } = onboard(store, "Acme", "acme-pay");
    assert.match(apiKey, /^agk_[A-Za-z0-9_-]{43}$/);
    const again = new CustomerStore({ persistencePath: path });
    assert.equal(again.authenticate(apiKey)?.name, "Acme");
    assert.equal(again.hasAnyCustomers(), true);
    for (const file of readdirSync(dir)) assert.ok(!readFileSync(join(dir, file)).includes(apiKey), `key found in plaintext in ${file}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a customer onboarded by the CLI while the server runs is accepted without a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-customers-live-"));
  const persistencePath = join(dir, "db.sqlite");
  const app = await startApp({ persistencePath });
  try {
    assert.equal((await evaluate(app.baseUrl, undefined, "demo")).status, 200, "open mode");
    const acme = onboard(new CustomerStore({ persistencePath }), "Acme", "acme-pay"); // what scripts/customers.mjs does
    assert.equal((await evaluate(app.baseUrl, undefined, "demo")).status, 401);
    assert.equal((await evaluate(app.baseUrl, acme.apiKey, "acme-pay")).status, 200);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a database created before customers existed gets the customer column and keeps its old history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-migrate-"));
  const path = join(dir, "db.sqlite");
  try {
    const { openSqliteDatabase } = await import("../src/storage/sqlite.js");
    const old = openSqliteDatabase(path);
    old.exec(`CREATE TABLE evaluation_log (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, policy_id TEXT NOT NULL, evaluation_json TEXT NOT NULL, recorded_at TEXT NOT NULL) STRICT;
      INSERT INTO evaluation_log VALUES ('old-1', 'agent-1', 'demo', '{"decision":"ALLOW","reasons":[],"decoded":{"feePayer":"p","instructions":[]}}', '2026-01-01T00:00:00.000Z');`);
    const { EvaluationLog } = await import("../src/observability/evaluation-log.js");
    const log = new EvaluationLog({ persistencePath: path });
    assert.equal(log.query({ agentId: "agent-1" }).length, 1, "old row still readable (open mode)");
    assert.equal(log.query({ agentId: "agent-1", customerId: "any-customer" }).length, 0, "old rows belong to no customer");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
