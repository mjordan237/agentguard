import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";

const ETH = 10n ** 18n;
const agent = "0x1111111111111111111111111111111111111111";
const vendor = "0x2222222222222222222222222222222222222222";
const attacker = "0x3333333333333333333333333333333333333333";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addr = (a: string) => a.slice(2).padStart(64, "0");

async function setup() {
  const customers = new CustomerStore();
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, {
    policyId: "acme-evm", programAllowlist: ["evm:native", usdc], destinationAllowlist: [vendor],
    maxAmountPerTransaction: { native: String(ETH), [usdc]: "1000000000" }, maxAmountPerDay: { native: String(3n * ETH), [usdc]: "3000000000" },
    allowedChainIds: [1]
  });
  const globex = customers.create("globex");
  customers.setPolicy(globex.id, {
    policyId: "globex-evm", programAllowlist: ["evm:native"], destinationAllowlist: [], allowAnyDestination: true,
    maxAmountPerTransaction: { native: String(100n * ETH) }, maxAmountPerDay: { native: String(1000n * ETH) }, allowedChainIds: [1]
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const app = createServer(new Map(), buildDemoRegistry(), { baseUrl: "http://placeholder", reviewActionSecret: "s", customers, reviewers: new ReviewerStore() });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${apiKey}` }, path = "/evaluate-evm") => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const send = (transaction: object, over: object = {}) => post({ agentId: "a1", policyId: "acme-evm", transaction: { chainId: 1, from: agent, ...transaction }, ...over });
  const permit = (over: Record<string, unknown> = {}, extra: object = {}) => post({
    agentId: "a1", policyId: "acme-evm", from: agent,
    typedData: {
      domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: usdc }, primaryType: "Permit",
      types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      message: { owner: agent, spender: vendor, value: "500000000", nonce: "0", deadline: String(Math.floor(Date.now() / 1000) + 3600), ...over }
    }, ...extra
  }, undefined, "/evaluate-evm-typed");
  return { post, send, permit, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test("evm api: allowed payment, attacker payment and unlimited approval", async () => {
  const t = await setup();
  try {
    const ok = await t.send({ to: vendor, value: (ETH / 2n).toString() });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.decision, "ALLOW");
    const bad = await t.send({ to: attacker, value: "1" });
    assert.equal(bad.body.decision, "NEEDS_REVIEW");
    assert.ok(bad.body.reviewId);
    const max = (1n << 256n) - 1n;
    const approve = await t.send({ to: usdc, data: `0x095ea7b3${addr(vendor)}${word(max)}` });
    assert.equal(approve.body.decision, "NEEDS_REVIEW");
  } finally { await t.close(); }
});

test("evm api: with reserve, the daily cap holds under 30 concurrent requests", async () => {
  const t = await setup();
  try {
    const results = await Promise.all(Array.from({ length: 30 }, () => t.send({ to: vendor, value: (ETH / 2n).toString() }, { reserve: true })));
    const allowed = results.filter((r) => r.body?.decision === "ALLOW").length;
    assert.equal(allowed, 6, "6 x 0.5 ETH = the 3 ETH daily cap");
  } finally { await t.close(); }
});

test("evm api: without reserve the call is a preview and spends nothing", async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await t.send({ to: vendor, value: ETH.toString() })).body.decision, "ALLOW");
  } finally { await t.close(); }
});

test("evm api: another customer's policy, a missing key, a bad body and a wrong chain are all refused", async () => {
  const t = await setup();
  try {
    assert.equal((await t.post({ agentId: "a", policyId: "globex-evm", transaction: { chainId: 1, from: agent, to: attacker, value: "1" } })).status, 404);
    assert.equal((await t.post({ agentId: "a", policyId: "acme-evm", transaction: { chainId: 1, from: agent, to: vendor } }, {})).status, 401);
    assert.equal((await t.send({ to: vendor, value: "-5" })).status, 400);
    assert.equal((await t.post({ agentId: "a", policyId: "acme-evm", transaction: { chainId: 1, from: agent, to: vendor, extra: 1 } })).status, 400);
    assert.equal((await t.send({ chainId: 137, to: vendor, value: "1" })).body.decision, "NEEDS_REVIEW");
  } finally { await t.close(); }
});

test("evm typed api: a permit to the vendor is allowed; to an attacker or for an unlimited amount it goes to review", async () => {
  const t = await setup();
  try {
    assert.equal((await t.permit()).body.decision, "ALLOW");
    const attacker1 = await t.permit({ spender: attacker });
    assert.equal(attacker1.body.decision, "NEEDS_REVIEW");
    assert.ok(attacker1.body.reviewId);
    assert.equal((await t.permit({ value: ((1n << 256n) - 1n).toString() })).body.decision, "NEEDS_REVIEW");
  } finally { await t.close(); }
});

test("evm typed api: with reserve, 30 concurrent permits cannot exceed the daily cap", async () => {
  const t = await setup();
  try {
    const results = await Promise.all(Array.from({ length: 30 }, () => t.permit({}, { reserve: true })));
    assert.equal(results.filter((r) => r.body?.decision === "ALLOW").length, 6, "6 x 500 USDC = the 3000 USDC daily cap");
  } finally { await t.close(); }
});

test("evm typed api: a permit and a transaction share the same daily budget", async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await t.permit({}, { reserve: true })).body.decision, "ALLOW"); // 2500 of 3000 USDC
    const approve = await t.send({ to: usdc, data: `0x095ea7b3${vendor.slice(2).padStart(64, "0")}${(600_000_000n).toString(16).padStart(64, "0")}` }, { reserve: true });
    assert.equal(approve.body.decision, "NEEDS_REVIEW", "2500 + 600 breaks the 3000 cap");
  } finally { await t.close(); }
});

test("evm typed api: another customer's policy, a missing key and a malformed body are refused", async () => {
  const t = await setup();
  try {
    assert.equal((await t.post({ agentId: "a", policyId: "globex-evm", from: agent, typedData: { domain: {}, types: {}, primaryType: "Permit", message: {} } }, undefined, "/evaluate-evm-typed")).status, 404);
    assert.equal((await t.post({ agentId: "a", policyId: "acme-evm", from: agent, typedData: { domain: {}, types: {}, primaryType: "Permit", message: {} } }, {}, "/evaluate-evm-typed")).status, 401);
    assert.equal((await t.post({ agentId: "a", policyId: "acme-evm", from: agent }, undefined, "/evaluate-evm-typed")).status, 400);
  } finally { await t.close(); }
});
