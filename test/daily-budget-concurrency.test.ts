import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/api/server.js";
import { buildDemoRegistry } from "../demo/policy.js";
import type { Policy } from "../src/policy/types.js";
import { DailySpendTracker } from "../src/policy/daily-spend-tracker.js";
import { EvaluationLog } from "../src/observability/evaluation-log.js";

/**
 * A deterministic regression for the daily-budget read-then-reserve race. The daily limit is read at evaluation
 * time, then an awaited EVM code check runs, then the spend is reserved. Two requests overlapped at the code check
 * each fit alone but exceed the limit together. A code-lookup barrier controls the interleaving explicitly, with no
 * timing sleeps. The invariant: across concurrent auto-ALLOWs, at most the daily limit is ever reserved, so when two
 * half-limit requests overlap exactly one is admitted and the other is routed to review.
 */

const agent = "0x1111111111111111111111111111111111111111";
const vendor = "0x2222222222222222222222222222222222222222";
const HALF = "600000000000000000"; // 0.6 ETH; two of these exceed the 1 ETH daily limit, each fits alone
const policy: Policy = {
  policyId: "evm-pay", programAllowlist: ["evm:native"], destinationAllowlist: [vendor],
  maxAmountPerTransaction: { native: HALF }, maxAmountPerDay: { native: "1000000000000000000" }, allowedChainIds: [1]
};

/** Resolves every caller only once `n` callers have arrived, so two requests are held together at the code check. */
function barrier(n: number) {
  let count = 0;
  const waiters: Array<() => void> = [];
  return () => new Promise<void>((resolve) => { waiters.push(resolve); if (++count >= n) waiters.forEach((w) => w()); });
}

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-budget-race-"));
  const path = join(dir, "db.sqlite");
  const gate = barrier(2);
  const app = createServer(new Map([[policy.policyId, policy]]), buildDemoRegistry(), {
    baseUrl: "http://placeholder", persistencePath: path,
    evmCodeLookup: async () => { await gate(); return "0x"; } // EOA destination (no code); the await is the overlap point
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const evaluate = () => fetch(`${base}/evaluate-evm`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "a", policyId: policy.policyId, reserve: true, transaction: { chainId: 1, from: agent, to: vendor, value: HALF, data: "0x" } })
  }).then((r) => r.json() as Promise<{ decision: string; reviewId?: string }>);
  return {
    evaluate, path,
    spentNative: () => new DailySpendTracker({ persistencePath: path }).spentToday(policy.policyId).native ?? 0n,
    storedEntries: () => new EvaluationLog({ persistencePath: path }).query({ agentId: "a" }),
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("daily budget: two concurrent half-limit auto-ALLOWs never reserve more than the daily limit together", async () => {
  const w = await world();
  try {
    const [a, b] = await Promise.all([w.evaluate(), w.evaluate()]); // both held at the code check, then released together
    const decisions = [a.decision, b.decision].sort();
    assert.deepEqual(decisions, ["ALLOW", "NEEDS_REVIEW"], "exactly one is admitted; the other is routed to review");
    assert.equal(w.spentNative(), BigInt(HALF), "only the admitted request's spend is reserved; the limit is not exceeded");
    const review = [a, b].find((r) => r.decision === "NEEDS_REVIEW")!;
    assert.ok(review.reviewId, "the request over the daily limit gets a review a human can still approve");
    // The persisted evaluation history must agree with the responses: one ALLOW, one NEEDS_REVIEW, not two ALLOWs.
    const entries = w.storedEntries();
    assert.deepEqual(entries.map((e) => e.evaluation.decision).sort(), ["ALLOW", "NEEDS_REVIEW"], "persisted decisions match the responses");
    const storedReview = entries.find((e) => e.evaluation.decision === "NEEDS_REVIEW")!;
    assert.ok(storedReview.evaluation.reasons.some((r) => r.includes("daily limit")), "the persisted review entry carries the daily-limit reason");
  } finally { await w.close(); }
});

test("daily budget: when the two do not overlap, the first is admitted and the second is a review, totalling the limit", async () => {
  // Same amounts run sequentially: the second reads the first's reservation and is a review, not an over-budget allow.
  const dir = mkdtempSync(join(tmpdir(), "agentguard-budget-seq-"));
  const path = join(dir, "db.sqlite");
  const app = createServer(new Map([[policy.policyId, policy]]), buildDemoRegistry(), {
    baseUrl: "http://placeholder", persistencePath: path, evmCodeLookup: async () => "0x"
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const evaluate = () => fetch(`${base}/evaluate-evm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "a", policyId: policy.policyId, reserve: true, transaction: { chainId: 1, from: agent, to: vendor, value: HALF, data: "0x" } }) }).then((r) => r.json() as Promise<{ decision: string }>);
  try {
    assert.equal((await evaluate()).decision, "ALLOW");
    assert.equal((await evaluate()).decision, "NEEDS_REVIEW");
    assert.equal(new DailySpendTracker({ persistencePath: path }).spentToday(policy.policyId).native, BigInt(HALF));
  } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); rmSync(dir, { recursive: true, force: true }); }
});

test("daily budget: the atomic reserve is idempotent and refuses only when it would exceed the limit", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-budget-unit-"));
  const path = join(dir, "db.sqlite");
  try {
    const tracker = new DailySpendTracker({ persistencePath: path });
    const limits = { native: 1000n };
    const first = tracker.reserveWithinLimit("p", { native: 600n }, limits, "r1");
    assert.ok(first, "first fits");
    assert.deepEqual(tracker.reserveWithinLimit("p", { native: 600n }, limits, "r1"), first, "idempotent by id: no double charge");
    assert.equal(tracker.reserveWithinLimit("p", { native: 600n }, limits, "r2"), null, "a second distinct reservation would exceed the limit: refused");
    assert.equal(tracker.spentToday("p").native, 600n, "the refused reservation charged nothing");
    assert.ok(tracker.reserveWithinLimit("p", { native: 400n }, limits, "r3"), "an amount that fits the remaining budget is admitted");
    assert.equal(tracker.spentToday("p").native, 1000n);
    assert.ok(tracker.reserveWithinLimit("p", { gas: 999999n }, limits, "r4"), "an asset without a configured daily limit is not capped");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("daily budget: reservations racing through independent SQLite connections never exceed the cap", async () => {
  const { Worker } = await import("node:worker_threads");
  const { fileURLToPath } = await import("node:url");
  const worker = fileURLToPath(new URL("./budget-reservation-worker.js", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "agentguard-budget-workers-"));
  const path = join(dir, "db.sqlite");
  try {
    new DailySpendTracker({ persistencePath: path }); // create the file/schema before the workers open it
    const CAP = 1000n, EACH = 300n, N = 6; // floor(1000/300) = 3 can fit; the rest must be refused
    const gate = new SharedArrayBuffer(8);
    const flag = new Int32Array(gate);
    const results = Array.from({ length: N }, (_, i) => new Promise<string>((resolve, reject) => {
      const w = new Worker(worker, { workerData: { path, amount: EACH.toString(), limit: CAP.toString(), id: `w${i}`, gate } });
      w.once("message", (m: string) => { resolve(m); void w.terminate(); });
      w.once("error", reject);
    }));
    while (Atomics.load(flag, 1) < N) await new Promise((r) => setTimeout(r, 5)); // all workers ready and blocked
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0); // release them together
    const outcomes = await Promise.all(results);
    const reserved = outcomes.filter((o) => o === "reserved").length;
    const spent = new DailySpendTracker({ persistencePath: path }).spentToday("p").native ?? 0n;
    assert.equal(spent, BigInt(reserved) * EACH, "the ledger equals the reservations that succeeded");
    assert.ok(spent <= CAP, `reserved total ${spent} must never exceed the cap ${CAP}`);
    assert.equal(reserved, 3, "exactly as many as fit are admitted, no more");
    assert.ok(spent + EACH > CAP, "the cap is fully used: no further reservation of this size would fit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
