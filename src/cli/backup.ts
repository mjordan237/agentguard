#!/usr/bin/env node
/**
 * Takes a consistent snapshot of the AgentGuard database while the server is running, then checks the copy:
 * SQLite's own integrity check, a row count per table, and every customer's audit chain. It never changes the
 * source database and never overwrites an existing file.
 *
 *   node dist/src/cli/backup.js --out backups/agentguard-2026-10-24.sqlite [--db agentguard.sqlite]
 *
 * --db defaults to AGENTGUARD_DB_PATH, then to agentguard.sqlite, the same as the server.
 * Exit code: 0 = copy written and every check passed, 1 = anything else. If a check fails the copy is kept,
 * because a damaged database or a broken audit chain is evidence, not something to throw away.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { eventFromRow, verifyChain, type Row } from "../observability/audit-log.js";

interface Statement { all(...p: unknown[]): unknown[]; get(...p: unknown[]): unknown }
interface Db { prepare(sql: string): Statement; close(): void }
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => Db;
  backup?: (source: Db, path: string) => Promise<number>;
}
const { DatabaseSync, backup } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;

const USAGE = `AgentGuard database backup

Usage: backup --out <new file> [--db <database file>]

  --out   where to write the copy. Must not exist yet.
  --db    the database to copy (default: $AGENTGUARD_DB_PATH, then agentguard.sqlite)

Safe to run while the server is running. Exit code 0 only if the copy was written and every check passed.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  let values;
  try {
    values = parseArgs({ options: { out: { type: "string" }, db: { type: "string" }, help: { type: "boolean" } }, allowPositionals: false }).values;
  } catch (error) { fail(`${(error as Error).message}\n\n${USAGE}`); }
  if (values.help) { console.log(USAGE); return; }
  if (!values.out) fail(`--out is required.\n\n${USAGE}`);

  const source = resolve(values.db ?? process.env.AGENTGUARD_DB_PATH ?? "agentguard.sqlite");
  const out = resolve(values.out);
  if (!existsSync(source)) fail(`No database at ${source}. Nothing was created.`);
  if (existsSync(out)) fail(`${out} already exists. Backups never overwrite; pick a new name.`);
  if (typeof backup !== "function") fail("This version of Node has no built-in SQLite backup. Use Node 22.19 or newer, or run: sqlite3 <database> \".backup <file>\"");
  mkdirSync(dirname(out), { recursive: true });

  let pages: number;
  const original = new DatabaseSync(source, { readOnly: true });
  try { pages = await backup(original, out); }
  catch (error) { fail(`Backup failed: ${(error as Error).message}`); }
  finally { original.close(); }

  const copy = new DatabaseSync(out, { readOnly: true });
  let healthy = true;
  try {
    const integrity = (copy.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
    const intact = integrity.length === 1 && integrity[0] === "ok";
    console.log(`Wrote ${out}`);
    console.log(`  size: ${statSync(out).size} bytes (${pages} pages)`);
    console.log(`  integrity check: ${intact ? "ok" : `FAILED: ${integrity.slice(0, 5).join("; ")}`}`);
    healthy &&= intact;

    const tables = (copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    console.log("  rows per table:");
    for (const name of tables) {
      const count = (copy.prepare(`SELECT COUNT(*) AS c FROM "${name.replace(/"/g, '""')}"`).get() as { c: number }).c;
      console.log(`    ${name}: ${count}`);
    }

    if (tables.includes("audit_events")) {
      const scopes = (copy.prepare("SELECT DISTINCT scope FROM audit_events ORDER BY scope").all() as Array<{ scope: string }>).map((r) => r.scope);
      console.log("  audit chains (store each head hash somewhere the database's owner cannot write):");
      for (const scope of scopes) {
        const result = verifyChain((after) => (copy.prepare("SELECT n, at, scope, type, data_json, prev_hash, hash FROM audit_events WHERE scope = ? AND n > ? ORDER BY n ASC LIMIT 1000").all(scope, after) as Row[]).map(eventFromRow));
        if (result.ok) console.log(`    ${scope}: ${result.events} events, head ${result.headHash || "(none)"}`);
        else { healthy = false; console.log(`    ${scope}: BROKEN at event ${result.brokenAt?.n}: ${result.brokenAt?.reason}`); }
      }
    }
  } finally { copy.close(); }

  if (!healthy) fail("A check failed. The copy was kept as evidence; do not treat it as a good backup.");
  console.log("All checks passed.");
}

await main();
