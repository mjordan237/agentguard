import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog, GENESIS_HASH, canonicalize, hashEvent } from "../src/observability/audit-log.js";
import { openSqliteDatabase } from "../src/storage/sqlite.js";

const dbPath = () => path.join(mkdtempSync(path.join(tmpdir(), "audit-")), "a.sqlite");
const fill = (log: AuditLog, scope: string | undefined, count: number) => {
  for (let i = 0; i < count; i++) log.append(scope, i % 2 ? "signed" : "evaluated", { i, agent: "bot", amount: BigInt(i) * 10n ** 18n });
};

for (const mode of ["memory", "sqlite"] as const) {
  test(`audit log (${mode}): chains are per customer, ordered, linked and verifiable`, () => {
    const log = new AuditLog(mode === "sqlite" ? { persistencePath: dbPath() } : {});
    fill(log, "cust-a", 5);
    fill(log, "cust-b", 3);
    fill(log, undefined, 2);

    const a = log.list("cust-a");
    assert.deepEqual(a.map((e) => e.n), [1, 2, 3, 4, 5]);
    assert.equal(a[0]!.prevHash, GENESIS_HASH);
    for (let i = 1; i < a.length; i++) assert.equal(a[i]!.prevHash, a[i - 1]!.hash);
    assert.equal(log.list("cust-b").length, 3);
    assert.equal(log.list(undefined).length, 2, "demo-mode events live in their own chain");
    assert.ok(log.list("cust-a").every((e) => e.scope === "cust-a"), "one customer never sees another's events");

    assert.deepEqual(log.list("cust-a", { after: 2, limit: 2 }).map((e) => e.n), [3, 4]);
    assert.equal(log.list("cust-a", { limit: 0 }).length, 1, "limit is clamped to at least 1");
    assert.equal(log.list("nobody").length, 0);

    const v = log.verify("cust-a");
    assert.deepEqual({ ok: v.ok, events: v.events, headHash: v.headHash }, { ok: true, events: 5, headHash: a[4]!.hash });
    assert.deepEqual(log.verify("nobody"), { ok: true, events: 0, headHash: "" });
    assert.equal(a[1]!.data.amount, "1000000000000000000", "bigint is stored as a decimal string");
  });
}

test("audit log: hashing ignores key order and undefined, and distinguishes real differences", () => {
  assert.equal(canonicalize({ b: 1, a: [{ d: 2, c: undefined }] }), canonicalize({ a: [{ c: undefined, d: 2 }], b: 1 }));
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: "1" }));
  const base = { n: 1, at: "2026-01-01T00:00:00.000Z", scope: "s", type: "signed" as const, data: { x: 1 }, prevHash: GENESIS_HASH };
  const h = hashEvent(base);
  for (const changed of [{ n: 2 }, { at: "2026-01-01T00:00:00.001Z" }, { scope: "t" }, { type: "evaluated" as const }, { data: { x: 2 } }, { prevHash: "1".repeat(64) }]) {
    assert.notEqual(hashEvent({ ...base, ...changed }), h, JSON.stringify(changed));
  }
});

test("audit log (sqlite): survives a restart and keeps extending the same chain", () => {
  const p = dbPath();
  const first = new AuditLog({ persistencePath: p });
  fill(first, "c", 3);
  const head = first.verify("c").headHash;
  const second = new AuditLog({ persistencePath: p });
  assert.equal(second.verify("c").headHash, head);
  const next = second.append("c", "signed", { signature: "sig" });
  assert.equal(next.n, 4);
  assert.equal(next.prevHash, head);
  assert.equal(second.verify("c").ok, true);
});

test("audit log (sqlite): the database itself refuses to edit or delete events", () => {
  const p = dbPath();
  const log = new AuditLog({ persistencePath: p });
  fill(log, "c", 2);
  const db = openSqliteDatabase(p);
  assert.throws(() => db.prepare("UPDATE audit_events SET data_json = '{}' WHERE n = 1").run(), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM audit_events WHERE n = 1").run(), /append-only/);
  assert.equal(log.verify("c").ok, true);
});

/** Opens the file the way an attacker with write access would, removing the triggers first. */
function attacker(p: string) {
  const db = openSqliteDatabase(p);
  db.exec("DROP TRIGGER audit_events_no_update; DROP TRIGGER audit_events_no_delete;");
  return db;
}

test("audit log (sqlite): every kind of tampering in the middle is detected, at the right place", () => {
  const cases: Array<[string, (db: ReturnType<typeof openSqliteDatabase>) => void, number, RegExp]> = [
    ["edit the data", (db) => db.prepare("UPDATE audit_events SET data_json = ? WHERE scope = 'c' AND n = 3").run('{"i":999}'), 3, /do not match its hash/],
    ["edit the time", (db) => db.prepare("UPDATE audit_events SET at = '2020-01-01T00:00:00.000Z' WHERE scope = 'c' AND n = 3").run(), 3, /do not match its hash/],
    ["edit the type", (db) => db.prepare("UPDATE audit_events SET type = 'review_opened' WHERE scope = 'c' AND n = 3").run(), 3, /do not match its hash/],
    ["edit the stored hash", (db) => db.prepare("UPDATE audit_events SET hash = ? WHERE scope = 'c' AND n = 3").run("f".repeat(64)), 3, /do not match its hash/],
    ["edit the link", (db) => db.prepare("UPDATE audit_events SET prev_hash = ? WHERE scope = 'c' AND n = 3").run("e".repeat(64)), 3, /does not link/],
    ["delete an event", (db) => db.prepare("DELETE FROM audit_events WHERE scope = 'c' AND n = 3").run(), 4, /missing/],
    ["delete the first event", (db) => db.prepare("DELETE FROM audit_events WHERE scope = 'c' AND n = 1").run(), 2, /missing/]
  ];
  for (const [name, tamper, brokenN, reason] of cases) {
    const p = dbPath();
    const log = new AuditLog({ persistencePath: p });
    fill(log, "c", 6);
    fill(log, "other", 2);
    tamper(attacker(p));
    const v = log.verify("c");
    assert.equal(v.ok, false, name);
    assert.equal(v.brokenAt?.n, brokenN, name);
    assert.match(v.brokenAt?.reason ?? "", reason, name);
    assert.equal(log.verify("other").ok, true, `${name}: another customer's chain is unaffected`);
  }
});

test("audit log (sqlite): the stated limits - tail truncation and a full rewrite are not caught by the chain alone, but headHash exposes them", () => {
  const p = dbPath();
  const log = new AuditLog({ persistencePath: p });
  fill(log, "c", 5);
  const recorded = log.verify("c").headHash; // what an operator would have stored somewhere else

  attacker(p).prepare("DELETE FROM audit_events WHERE n > 3").run();
  const truncated = log.verify("c");
  assert.equal(truncated.ok, true, "a shorter chain is still a valid chain");
  assert.equal(truncated.events, 3);
  assert.notEqual(truncated.headHash, recorded, "but the head no longer matches the one stored elsewhere");
});

test("audit log: seeded random corruption is always detected (400 trials)", () => {
  let seed = 20261024;
  const rand = (n: number) => { seed = (seed * 1664525 + 1013904223) % 2 ** 32; return seed % n; };
  for (let trial = 0; trial < 400; trial++) {
    const log = new AuditLog();
    const total = 3 + rand(8);
    fill(log, "c", total);
    // reach into the in-memory chain the way a buggy or hostile process might
    const events = (log as unknown as { memory: Map<string, Array<Record<string, unknown>>> }).memory.get("c")!;
    const target = rand(total);
    const kind = rand(5);
    let firstBroken = target + 1;
    if (kind === 0) events[target]!.data = { tampered: trial };
    else if (kind === 1) events[target]!.at = "1999-01-01T00:00:00.000Z";
    else if (kind === 2) events[target]!.type = events[target]!.type === "signed" ? "evaluated" : "signed";
    else if (kind === 3) events[target]!.hash = String(trial).padStart(64, "a");
    else { if (target === total - 1) continue; events.splice(target, 1); firstBroken = target + 2; }
    const v = log.verify("c");
    assert.equal(v.ok, false, `trial ${trial} kind ${kind} target ${target}`);
    assert.equal(v.brokenAt?.n, kind === 3 ? target + 1 : firstBroken, `trial ${trial} kind ${kind} target ${target}`);
  }
});
