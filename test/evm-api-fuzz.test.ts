import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";
import { LocalKeySigner } from "../src/evm/sign.js";
import { keccak_256 } from "@noble/hashes/sha3";

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const signer = new LocalKeySigner(keccak_256(new TextEncoder().encode("api fuzz key")));
const vendor = "0x2222222222222222222222222222222222222222";
const HUGE = 10n ** 77n * 9n; // larger than 2^256

async function start() {
  const customers = new CustomerStore();
  const c = customers.create("fuzz", 1_000_000);
  // Deliberately loose caps: the only thing standing between these requests and a signature is the request validation.
  customers.setPolicy(c.id, {
    policyId: "p", programAllowlist: ["evm:native"], destinationAllowlist: [vendor],
    maxAmountPerTransaction: { native: (HUGE * 10n).toString(), "evm:gas": (HUGE * 10n).toString() },
    maxAmountPerDay: { native: (HUGE * 10n).toString(), "evm:gas": (HUGE * 10n).toString() }, allowedChainIds: [1]
  });
  const apiKey = c.id && customers.issueKey(c.id).apiKey;
  const app = createServer(new Map(), buildDemoRegistry(), { baseUrl: "http://placeholder", reviewActionSecret: "s", customers, reviewers: new ReviewerStore(), evmSigner: signer, rateLimit: { maxRequests: 1_000_000, windowMs: 60_000 } });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, raw = false) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: raw ? String(body) : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  return { post, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

const goodTx = { chainId: 1, from: signer.address, to: vendor, value: "1", nonce: "0", gasLimit: "21000", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "1000000" };

test("evm api: numbers that cannot exist on chain are rejected before anything is signed", async () => {
  const t = await start();
  try {
    const sign = (over: object) => t.post("/gate-and-sign-evm", { agentId: "a", policyId: "p", transaction: { ...goodTx, ...over } });
    assert.equal((await sign({})).status, 200, "the baseline request signs");
    for (const [field, value] of [
      ["value", HUGE.toString()], ["maxFeePerGas", HUGE.toString()], ["maxPriorityFeePerGas", HUGE.toString()],
      ["nonce", (2n ** 64n).toString()], ["gasLimit", (2n ** 64n).toString()], ["chainId", 2 ** 53]
    ] as const) {
      const r = await sign({ [field]: value });
      assert.equal(r.status, 400, `${field}=${value} must be rejected, got ${r.status}`);
      assert.equal(r.body.signedTransaction, undefined, `${field}=${value} must not be signed`);
    }
  } finally { await t.close(); }
});

test("evm api: random and malformed bodies never produce a 500 or an unexpected signature", async () => {
  const t = await start();
  const r = rng(424242);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const junk = () => pick<unknown>([undefined, null, 0, -1, 1.5, "", "x", "0x", "1e18", " 1", "-1", "0x10", "٣", [], {}, [1], { a: 1 }, true, "9".repeat(80), "1".repeat(78), vendor, signer.address, "0x" + "ab".repeat(100)]);
  const tally: Record<number, number> = {};
  try {
    for (let i = 0; i < 600; i++) {
      const tx: Record<string, unknown> = { ...goodTx };
      for (const k of Object.keys(tx)) if (r() < 0.25) tx[k] = junk();
      if (r() < 0.1) tx.extra = junk();
      if (r() < 0.2) tx.data = pick(["0x", "0xdeadbeef", "0xzz", "0xa9059cbb" + "00".repeat(10), "0X12", "12"]);
      const body: Record<string, unknown> = { agentId: pick(["a", junk()]), policyId: pick(["p", "p", junk()]), transaction: tx };
      if (r() < 0.2) body.reviewId = junk();
      if (r() < 0.2) body.broadcast = junk();
      const path = pick(["/gate-and-sign-evm", "/evaluate-evm", "/evaluate-evm-typed"]);
      const res = await t.post(path, r() < 0.05 ? "{not json" : body, false);
      assert.ok(res.status < 500, `${path} gave ${res.status} ${JSON.stringify(res.body)} for ${JSON.stringify(body)}`);
      tally[res.status] = (tally[res.status] ?? 0) + 1;
      if (res.body?.signedTransaction) assert.equal(path, "/gate-and-sign-evm");
    }
    console.log(`# api fuzz statuses: ${JSON.stringify(tally)}`);
    assert.equal(tally[429] ?? 0, 0, "the rate limiter must not hide the requests from validation");
    assert.ok((tally[400] ?? 0) > 100 && (tally[200] ?? 0) > 5, `the mix of statuses should show validation and success paths: ${JSON.stringify(tally)}`);
    for (const raw of ["{not json", "[]", "null", "\"s\"", "123", ""]) {
      const res = await t.post("/gate-and-sign-evm", raw, true);
      assert.ok(res.status === 400, `raw body ${JSON.stringify(raw)} gave ${res.status}`);
    }
  } finally { await t.close(); }
});
