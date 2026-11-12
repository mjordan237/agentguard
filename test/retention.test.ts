import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvaluationLog } from "../src/observability/evaluation-log.js";
import { PendingReviewStore } from "../src/escalation/pending-store.js";
import { pruneOlderThan } from "../src/storage/retention.js";
import type { PolicyEvaluation } from "../src/policy/types.js";

const DAY = 86_400_000;
const evaluation = (decision: "ALLOW" | "NEEDS_REVIEW"): PolicyEvaluation => ({ decision, reasons: ["x"], decoded: { feePayer: "p", instructions: [] } } as unknown as PolicyEvaluation);

function withDb<T>(fn: (path: string) => Promise<T> | T) {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-retention-"));
  return Promise.resolve(fn(join(dir, "db.sqlite"))).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("history queries filter and limit in SQL and match the in-memory behaviour", () => withDb((path) => {
  const sqlite = new EvaluationLog({ persistencePath: path });
  const memory = new EvaluationLog();
  for (const log of [sqlite, memory]) {
    for (let i = 0; i < 12; i++) log.record(i % 3 === 0 ? "a" : "b", "demo", evaluation(i % 2 === 0 ? "ALLOW" : "NEEDS_REVIEW"));
  }
  const ids = (log: EvaluationLog, f = {}) => log.query(f).map((e) => `${e.agentId}:${e.evaluation.decision}`);
  for (const filter of [{}, { agentId: "a" }, { decision: "ALLOW" as const }, { agentId: "b", decision: "NEEDS_REVIEW" as const, limit: 2 }, { limit: 0 }, { limit: 5 }]) {
    assert.deepEqual(ids(sqlite, filter), ids(memory, filter), JSON.stringify(filter));
  }
  assert.deepEqual(sqlite.summaryByAgent("a"), memory.summaryByAgent("a"));
  assert.deepEqual(sqlite.summaryByAgent("nobody"), { total: 0, allow: 0, needsReview: 0 });
}));

test("a filter value cannot inject SQL", () => withDb((path) => {
  const log = new EvaluationLog({ persistencePath: path });
  log.record("a", "demo", evaluation("ALLOW"));
  assert.equal(log.query({ agentId: "a' OR '1'='1" }).length, 0);
  assert.equal(log.summaryByAgent("a' OR '1'='1").total, 0);
  assert.equal(log.query({}).length, 1);
}));

test("pruning deletes old history and expired reviews with their notes, and keeps recent and still-pending ones", () => withDb(async (path) => {
  const log = new EvaluationLog({ persistencePath: path });
  const reviews = new PendingReviewStore({ persistencePath: path, expiresInMs: 15 * 60_000 });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() - 40 * DAY; // written 40 days ago
    const oldEntry = log.record("a", "demo", evaluation("ALLOW"));
    const oldReview = reviews.create("a", evaluation("NEEDS_REVIEW"));
    reviews.attachExplanation(oldReview.id, { summary: "s", risks: [], model: "m", latencyMs: 1 });
    reviews.resolve(oldReview.id, "APPROVED", { kind: "shared-secret" });
  } finally { Date.now = realNow; }
  // The log stamps recordedAt from `new Date()`, which Date.now does not move, so backdate directly.
  const old = new Date(realNow() - 40 * DAY).toISOString();
  const raw = (log as unknown as { database: { prepare(s: string): { run(...a: unknown[]): unknown } } }).database;
  raw.prepare("UPDATE evaluation_log SET recorded_at = ?").run(old);
  const rawReviews = (reviews as unknown as { database: { prepare(s: string): { run(...a: unknown[]): unknown } } }).database;
  rawReviews.prepare("UPDATE pending_reviews SET created_at = ?, expires_at = ?").run(old, old);

  const recentEntry = log.record("a", "demo", evaluation("NEEDS_REVIEW"));
  const recentReview = reviews.create("a", evaluation("NEEDS_REVIEW")); // still PENDING and actionable

  const deleted = await pruneOlderThan([log, reviews], 30 * DAY);
  assert.equal(deleted, 2);
  assert.deepEqual(log.query({}).map((e) => e.id), [recentEntry.id]);
  assert.equal(reviews.get(recentReview.id)?.status, "PENDING");
  const counts = (table: string) => (rawReviews as unknown as { prepare(s: string): { get(): { n: number } } }).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  assert.equal(counts("pending_reviews"), 1);
  assert.equal(counts("review_explanations"), 0);
  assert.equal(counts("review_resolutions"), 0);
}));

test("pruning works on in-memory stores", async () => {
  const log = new EvaluationLog();
  for (let i = 0; i < 5; i++) log.record("a", "demo", evaluation("ALLOW"));
  assert.equal(await pruneOlderThan([log], 1000, Date.now() + 10_000), 5);
  assert.equal(log.query({}).length, 0);
  const reviews = new PendingReviewStore({ expiresInMs: 1000 });
  const r = reviews.create("a", evaluation("NEEDS_REVIEW"));
  assert.equal(await pruneOlderThan([reviews], 2000, Date.now()), 0);
  assert.equal(await pruneOlderThan([reviews], 2000, Date.now() + 60_000), 1);
  assert.equal(reviews.get(r.id), undefined);
});
