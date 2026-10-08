import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { RateLimiter } from "../src/api/rate-limiter.js";
import { createServer } from "../src/api/server.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";

function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("GET /healthz returns a minimal liveness response", async () => {
  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder" });
  const appHandle = await listen(http.createServer(app));

  try {
    const response = await fetch(`http://localhost:${appHandle.port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  } finally {
    await appHandle.close();
  }
});

// --- RateLimiter: unit tests ---

test("RateLimiter allows requests up to the configured max within a window", () => {
  const limiter = new RateLimiter(3, 60_000);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
});

test("RateLimiter blocks the request that exceeds the max within a window", () => {
  const limiter = new RateLimiter(2, 60_000);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
});

test("RateLimiter tracks keys independently -- one key being limited doesn't block another", () => {
  const limiter = new RateLimiter(1, 60_000);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  assert.equal(limiter.allow("b"), true);
});

test("RateLimiter resets once the window has elapsed", async () => {
  const limiter = new RateLimiter(1, 30);
  assert.equal(limiter.allow("a"), true);
  assert.equal(limiter.allow("a"), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(limiter.allow("a"), true);
});

// --- Real /evaluate endpoint: rate limiting applied ---

test("POST /evaluate returns 429 once the configured rate limit is exceeded", async () => {
  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder",
    rateLimit: { maxRequests: 2, windowMs: 60_000 }
  });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const body = { agentId: "agent-1", policyId: "demo", transactionBase64: "bogus" };
    const first = await postJson(`${baseUrl}/evaluate`, body);
    const second = await postJson(`${baseUrl}/evaluate`, body);
    const third = await postJson(`${baseUrl}/evaluate`, body);

    // All three reach request handling (first two aren't rate limited; this
    // bogus transaction fails to parse either way, the point here is purely
    // whether the rate limiter itself let the request through or not).
    assert.notEqual(first.status, 429);
    assert.notEqual(second.status, 429);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, "RATE_LIMITED");
  } finally {
    await appHandle.close();
  }
});

test("POST /evaluate rate limit defaults to 30/60s when not configured, well above normal test traffic", async () => {
  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder" });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const body = { agentId: "agent-1", policyId: "demo", transactionBase64: "bogus" };
    for (let i = 0; i < 5; i++) {
      const result = await postJson(`${baseUrl}/evaluate`, body);
      assert.notEqual(result.status, 429, `request ${i} should not be rate limited under the default`);
    }
  } finally {
    await appHandle.close();
  }
});

test("POST /squads/upgrade-check returns 429 once the configured rate limit is exceeded", async () => {
  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder",
    rateLimit: { maxRequests: 2, windowMs: 60_000 }
  });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const body = { multisigPda: "11111111111111111111111111111111", transactionIndex: 1 };
    const first = await postJson(`${baseUrl}/squads/upgrade-check`, body);
    const second = await postJson(`${baseUrl}/squads/upgrade-check`, body);
    const third = await postJson(`${baseUrl}/squads/upgrade-check`, body);

    // No connection is configured in this test, so the first two hit
    // CONNECTION_NOT_CONFIGURED rather than doing real work -- the point
    // here is purely that the rate limiter runs before that check at all,
    // proven by the third request being rejected before even reaching it.
    assert.notEqual(first.status, 429);
    assert.notEqual(second.status, 429);
    assert.equal(third.status, 429);
    assert.equal(third.body.error, "RATE_LIMITED");
  } finally {
    await appHandle.close();
  }
});
