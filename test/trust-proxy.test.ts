import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";
import { parseTrustProxy, trustProxyStartupLine } from "../src/api/trust-proxy.js";

/** Sends bad-key requests with a chosen X-Forwarded-For and reports the status of each. */
async function setup(trustProxy: number | undefined) {
  const customers = new CustomerStore();
  customers.create("acme", 1000);
  // Three failed logins per window per client, so the limiter is easy to exhaust.
  const app = createServer(new Map(), buildDemoRegistry(), { baseUrl: "http://x", customers, rateLimit: { maxRequests: 3, windowMs: 60_000 }, trustProxy });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/evaluate`;
  const badLogin = async (forwardedFor?: string) => (await fetch(url, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer agk_wrong", ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}) }, body: "{}"
  })).status;
  return { badLogin, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

test("trust proxy: unset means X-Forwarded-For is ignored, so a forged header cannot dodge the limit", async () => {
  const t = await setup(undefined);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push(await t.badLogin(`10.0.0.${i}`));
    assert.deepEqual(statuses, [401, 401, 401, 429, 429, 429], "a different forged address each time did not reset the budget");
  } finally { await t.close(); }
});

test("trust proxy: with one hop, clients behind the proxy have separate budgets, and a forged prefix does not help", async () => {
  const t = await setup(1);
  try {
    for (let i = 0; i < 3; i++) assert.equal(await t.badLogin("203.0.113.7"), 401);
    assert.equal(await t.badLogin("203.0.113.7"), 429, "the noisy client is limited");
    assert.equal(await t.badLogin("198.51.100.9"), 401, "a different client behind the same proxy is not locked out");

    // The proxy appends the real client address on the right. Anything the client put on the left is ignored.
    for (let i = 0; i < 3; i++) assert.equal(await t.badLogin(`1.1.1.${i}, 192.0.2.50`), 401);
    assert.equal(await t.badLogin("9.9.9.9, 192.0.2.50"), 429, "forging the left side did not give a fresh budget");
  } finally { await t.close(); }
});

test("trust proxy: a request without the header falls back to the socket address", async () => {
  const t = await setup(1);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push(await t.badLogin());
    assert.deepEqual(statuses, [401, 401, 401, 429]);
  } finally { await t.close(); }
});

test("trust proxy: the setting accepts only an exact hop count", () => {
  assert.equal(parseTrustProxy(undefined), undefined);
  assert.equal(parseTrustProxy(""), undefined);
  assert.equal(parseTrustProxy("false"), undefined);
  assert.equal(parseTrustProxy("0"), undefined);
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("10"), 10);
  for (const bad of ["true", "11", "-1", "1.5", "01", " 1", "loopback", "1,2", "٣", "100"]) assert.throws(() => parseTrustProxy(bad), /TRUST_PROXY must be/, bad);
  assert.match(trustProxyStartupLine(undefined), /TRUST_PROXY not set/);
  assert.match(trustProxyStartupLine(2), /trusting 2 proxy hops/);
  assert.match(trustProxyStartupLine(1), /trusting 1 proxy hop \(/);
});
