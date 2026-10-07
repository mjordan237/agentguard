import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const BIGINT_MARKER = "__agentguard_bigint__";
const require = createRequire(import.meta.url);

export interface SqliteStatement {
  run(...parameters: unknown[]): { changes: number | bigint };
  get(...parameters: unknown[]): unknown;
  all(...parameters: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

const { DatabaseSync } = require("node:sqlite") as SqliteModule;

export function openSqliteDatabase(path: string): SqliteDatabase {
  const directory = dirname(path);
  if (path !== ":memory:" && directory !== ".") {
    mkdirSync(directory, { recursive: true });
  }

  const database = new DatabaseSync(path);
  // Set the wait policy before requesting WAL mode. Two processes can open a
  // brand-new database at the same time; WAL setup briefly needs an exclusive
  // lock, so a configured busy timeout keeps that startup race from failing.
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA journal_mode = WAL;");
  return database;
}

/** Preserve bigint fields in decoded evaluations across a process restart. */
export function serializeStoredValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return { [BIGINT_MARKER]: item.toString() };
    return item;
  });
}

export function deserializeStoredValue<T>(value: string): T {
  return JSON.parse(value, (_key, item: unknown) => {
    if (
      typeof item === "object" &&
      item !== null &&
      Object.keys(item).length === 1 &&
      BIGINT_MARKER in item &&
      typeof (item as Record<string, unknown>)[BIGINT_MARKER] === "string"
    ) {
      return BigInt((item as Record<string, string>)[BIGINT_MARKER]);
    }
    return item;
  }) as T;
}
