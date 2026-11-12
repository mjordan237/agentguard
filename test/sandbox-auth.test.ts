import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CustomerStore } from "../src/customers/customer-store.js";
import { createSandboxServer } from "../src/sandbox/server.js";
import { sandboxExamples } from "../src/sandbox/examples.js";
import { sandboxRuntimeConfig } from "../src/sandbox/config.js";

async function start(customers: CustomerStore, persistencePath?: string) {
  const server = http.createServer(createSandboxServer({ customers, requireApiKeys: true, persistencePath }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, key?: string, body: unknown = sandboxExamples().examples[0]!.body) =>
    fetch(base + route, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  return { base, post, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

test("hosted policy checks reject missing, invalid and revoked keys before evaluation", async () => {
  const customers = new CustomerStore();
  const customer = customers.create("Integration test");
  const { apiKey, keyId } = customers.issueKey(customer.id);
  const api = await start(customers);
  try {
    for (const route of ["/v1/check", "/v1/policies/validate"]) {
      assert.equal((await api.post(route)).status, 401);
      assert.equal((await api.post(route, "invalid")).status, 401);
    }
    const allowed = await api.post("/v1/check", apiKey);
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as { decision: string }).decision, "ALLOW");
    customers.revokeKey(keyId);
    assert.equal((await api.post("/v1/check", apiKey)).status, 401);
    const replacement = customers.issueKey(customer.id).apiKey;
    assert.equal((await api.post("/v1/check", replacement)).status, 200);
    customers.revoke(customer.id);
    assert.equal((await api.post("/v1/check", replacement)).status, 401);
    assert.equal((await api.post("/v1/check")).status, 401, "revoking the last tenant never reopens the API");
  } finally { await api.close(); }
});

test("customer rate limits are independent of invalid-key traffic and other customers", async () => {
  const customers = new CustomerStore();
  const a = customers.create("A", 1), b = customers.create("B", 1);
  const keyA = customers.issueKey(a.id).apiKey, keyB = customers.issueKey(b.id).apiKey;
  const api = await start(customers);
  try {
    for (let i = 0; i < 61; i++) await api.post("/v1/check", "invalid");
    assert.equal((await api.post("/v1/check", keyA)).status, 200);
    const limited = await api.post("/v1/check", keyA);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal((await api.post("/v1/check", keyB)).status, 200);
  } finally { await api.close(); }
});

test("keys, revocation and rate windows survive API recreation with one database", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "preview-auth-"));
  const database = path.join(dir, "service.sqlite");
  const customers = new CustomerStore({ persistencePath: database });
  const customer = customers.create("Persistent", 1);
  const { apiKey, keyId } = customers.issueKey(customer.id);
  const first = await start(customers, database);
  try { assert.equal((await first.post("/v1/check", apiKey)).status, 200); }
  finally { await first.close(); }
  const restored = new CustomerStore({ persistencePath: database });
  const second = await start(restored, database);
  try {
    assert.equal((await second.post("/v1/check", apiKey)).status, 429, "restart does not reset the quota");
    restored.revokeKey(keyId);
    assert.equal((await second.post("/v1/check", apiKey)).status, 401);
  } finally { await second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("public discovery documents authentication and allows authorization-header preflight", async () => {
  const api = await start(new CustomerStore());
  try {
    for (const route of ["/", "/healthz", "/v1", "/v1/examples", "/openapi.json"]) assert.equal((await fetch(api.base + route)).status, 200);
    const discovery = await (await fetch(api.base + "/v1")).json() as { authentication: string };
    assert.equal(discovery.authentication, "bearer");
    const spec = await (await fetch(api.base + "/openapi.json")).json() as any;
    for (const route of ["/v1/check", "/v1/policies/validate"]) assert.deepEqual(spec.paths[route].post.security, [{ bearerAuth: [] }]);
    const preflight = await fetch(api.base + "/v1/check", { method: "OPTIONS", headers: { origin: "https://developer.example", "access-control-request-headers": "authorization,content-type" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers")!, /authorization/i);
    const html = await (await fetch(api.base)).text();
    assert.match(html, /type="password"/);
    assert.ok(!/localStorage|sessionStorage/.test(html));
  } finally { await api.close(); }
});

test("release verification exercises synthetic Solana and EVM requests without exposing the key", async () => {
  const customers = new CustomerStore();
  const customer = customers.create("Release verification");
  const { apiKey } = customers.issueKey(customer.id);
  const api = await start(customers);
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.resolve(import.meta.dirname, "../../scripts/verify-policy-api.mjs")], {
      env: { ...process.env, AGENTGUARD_API_URL: api.base, AGENTGUARD_API_KEY: apiKey, AGENTGUARD_EXPECT_COMMIT: "" }, timeout: 15_000
    });
    const result = JSON.parse(stdout) as { ok: boolean; signs: boolean; checked: Array<{ name: string }> };
    assert.equal(result.ok, true);
    assert.equal(result.signs, false);
    assert.ok(result.checked.some(check => check.name === "evm-transfer"));
    assert.ok(result.checked.some(check => check.name === "allowed-vendor-payment"));
    assert.ok(!stdout.includes(apiKey) && !stderr.includes(apiKey));
  } finally { await api.close(); }
});

test("production preview configuration fails closed without explicit controls", () => {
  const valid = { AGENTGUARD_PRODUCTION: "true", REQUIRE_API_KEYS: "true", AGENTGUARD_DB_PATH: "/data/service.sqlite", BASE_URL: "https://api.example.com", TRUST_PROXY: "1" };
  assert.equal(sandboxRuntimeConfig(valid).requireApiKeys, true);
  for (const key of Object.keys(valid)) {
    if (key === "AGENTGUARD_PRODUCTION") continue;
    const env: Record<string, string | undefined> = { ...valid, [key]: undefined };
    assert.throws(() => sandboxRuntimeConfig(env), /requires/, key);
  }
  for (const changes of [{ REQUIRE_API_KEYS: "false" }, { AGENTGUARD_PRODUCTION: "yes" }, { AGENTGUARD_DB_PATH: ":memory:" }, { BASE_URL: "http://api.example.com" }, { BASE_URL: "https://localhost" }, { BASE_URL: "https://user:secret@api.example.com" }, { TRUST_PROXY: "true" }, { PORT: "NaN" }]) {
    assert.throws(() => sandboxRuntimeConfig({ ...valid, ...changes }));
  }
  assert.throws(() => createSandboxServer({ requireApiKeys: true }), /customer store/);
});
