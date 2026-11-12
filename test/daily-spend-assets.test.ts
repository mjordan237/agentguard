import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DailySpendTracker } from "../src/policy/daily-spend-tracker.js";

// Regression: the in-memory tracker split its keys on ":", so an asset name containing a colon ("evm:gas") was
// recorded under the wrong date and never counted, which let an EVM fee cap be exceeded without limit.
for (const [label, options] of [["in memory", {}], ["sqlite", { persistencePath: join(mkdtempSync(join(tmpdir(), "spend-")), "a.db") }]] as const) {
  test(`daily spend (${label}): assets with a colon in the name are tracked, refunded and kept separate`, () => {
    const tracker = new DailySpendTracker(options);
    const r1 = tracker.record("p1", { "evm:gas": 5n, native: 7n });
    tracker.record("p1", { "evm:gas": 3n });
    tracker.record("p2", { "evm:gas": 100n });
    assert.deepEqual(tracker.spentToday("p1"), { "evm:gas": 8n, native: 7n });
    assert.deepEqual(tracker.spentToday("p2"), { "evm:gas": 100n });
    tracker.release(r1);
    assert.deepEqual(tracker.spentToday("p1"), { "evm:gas": 3n, native: 0n });
  });
}

test("a charge with an id is made once and refunded once, in memory and across a reopened database", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-spend-"));
  try {
    for (const options of [{}, { persistencePath: join(dir, "db.sqlite") }]) {
      const tracker = new DailySpendTracker(options);
      tracker.record("p", { native: 7n }); // someone else's spending
      const first = tracker.record("p", { native: 10n }, "activity");
      const again = (options as { persistencePath?: string }).persistencePath ? new DailySpendTracker(options) : tracker; // a restart, when there is a file
      assert.deepEqual(again.record("p", { native: 10n }, "activity"), first, "charging the same id again returns the first charge");
      assert.equal(again.spentToday("p").native, 17n, "and charges nothing more");
      assert.deepEqual(again.held("activity"), first);
      again.release(first);
      again.release(first);
      assert.equal(again.spentToday("p").native, 7n, "refunded once, not twice");
      assert.equal(again.held("activity"), undefined);
      again.record("p", { native: 10n }, "activity");
      assert.equal(again.spentToday("p").native, 17n, "a refunded id can be charged again, once");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
