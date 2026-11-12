import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditLog } from "../src/observability/audit-log.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { openSqliteDatabase } from "../src/storage/sqlite.js";

const CLI = path.resolve(import.meta.dirname, "../src/cli/backup.js");
const workdir = () => mkdtempSync(path.join(tmpdir(), "backup-"));
const quiet = (text: string) => text.replace(/.*ExperimentalWarning.*\n|.*trace-warnings.*\n/g, "");
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 120_000 });
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function makeDatabase(file: string) {
  const customers = new CustomerStore({ persistencePath: file });
  const customer = customers.create("acme", 100);
  const audit = new AuditLog({ persistencePath: file });
  for (let i = 0; i < 20; i++) audit.append(customer.id, "evaluated", { i });
  audit.append(undefined, "evaluated", { demo: true });
  return { customer, audit };
}

test("backup: a snapshot taken while the server is writing is whole and verifiable, and restoring from it works", async () => {
  const dir = workdir();
  const live = path.join(dir, "live.sqlite");
  const { customer, audit } = makeDatabase(live);
  const out = path.join(dir, "out", "copy.sqlite");

  const child = spawn(process.execPath, [CLI, "--db", live, "--out", out]);
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise<number | null>((resolve) => child.on("exit", resolve));
  let finished = false;
  void done.then(() => { finished = true; });
  let written = 0;
  while (!finished) { audit.append(customer.id, "signed", { written }); written++; await new Promise((r) => setImmediate(r)); }
  assert.equal(await done, 0, quiet(stderr));
  assert.ok(written > 0, "the writer really was running during the backup");

  assert.match(stdout, /integrity check: ok/);
  assert.match(stdout, /All checks passed\./);
  assert.match(stdout, new RegExp(`${customer.id}: \\d+ events, head [0-9a-f]{64}`));

  // Restore: the copy opens as a database, has the customer, and its chain is intact and still extendable.
  const restored = new AuditLog({ persistencePath: out });
  const check = restored.verify(customer.id);
  assert.equal(check.ok, true);
  assert.ok(check.events >= 20, "at least what existed before the backup started");
  assert.ok(new CustomerStore({ persistencePath: out }).hasAnyCustomers());
  assert.equal(restored.append(customer.id, "evaluated", { afterRestore: true }).n, check.events + 1);
  assert.equal(restored.verify(customer.id).ok, true);
  assert.equal(audit.verify(customer.id).ok, true, "the live database is fine too");
});

test("backup: the source is not modified", () => {
  const dir = workdir();
  const live = path.join(dir, "live.sqlite");
  makeDatabase(live);
  const files = [live, `${live}-wal`].filter(existsSync);
  const before = files.map(sha);
  const r = run("--db", live, "--out", path.join(dir, "copy.sqlite"));
  assert.equal(r.status, 0, quiet(r.stderr));
  assert.deepEqual(files.map(sha), before);
});

test("backup: it never overwrites, never creates a missing database, and explains bad input", () => {
  const dir = workdir();
  const live = path.join(dir, "live.sqlite");
  makeDatabase(live);

  const existing = path.join(dir, "precious.sqlite");
  writeFileSync(existing, "do not touch");
  const overwrite = run("--db", live, "--out", existing);
  assert.equal(overwrite.status, 1);
  assert.match(overwrite.stderr, /already exists/);
  assert.equal(readFileSync(existing, "utf8"), "do not touch");

  const missing = path.join(dir, "nope.sqlite");
  const noDb = run("--db", missing, "--out", path.join(dir, "x.sqlite"));
  assert.equal(noDb.status, 1);
  assert.match(noDb.stderr, /No database at/);
  assert.equal(existsSync(missing), false, "a missing source is not created");
  assert.equal(existsSync(path.join(dir, "x.sqlite")), false);

  assert.equal(run("--db", live).status, 1);
  assert.equal(run("--bogus").status, 1);
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Safe to run while the server is running/);
});

test("backup: a broken audit chain fails the run loudly, but the copy is kept as evidence", () => {
  const dir = workdir();
  const live = path.join(dir, "live.sqlite");
  const { customer } = makeDatabase(live);
  const db = openSqliteDatabase(live);
  db.exec("DROP TRIGGER audit_events_no_update;");
  db.prepare("UPDATE audit_events SET data_json = ? WHERE scope = ? AND n = 7").run('{"i":999}', customer.id);

  const out = path.join(dir, "copy.sqlite");
  const r = run("--db", live, "--out", out);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`${customer.id}: BROKEN at event 7`));
  assert.match(r.stdout, /open: 1 events/, "the other chain is still reported as fine");
  assert.match(r.stderr, /kept as evidence/);
  assert.ok(existsSync(out), "the copy is kept");
});
