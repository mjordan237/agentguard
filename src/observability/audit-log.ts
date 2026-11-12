import { createHash } from "node:crypto";
import { openSqliteDatabase, type SqliteDatabase } from "../storage/sqlite.js";

/**
 * An append-only trail of what happened to every request that mattered: evaluated, held, approved or denied
 * (and by whom), approval refused, signed (with the signature), or signing failed (with whether the outcome is
 * unknown). It answers "who allowed this signature, and when" after a restart, which the HTTP responses cannot.
 *
 * Each customer has its own chain. Every event's hash covers the previous event's hash, so editing or deleting an
 * event in the middle is detectable with verify(). What this does NOT give you: someone who can rewrite the whole
 * database file can recompute every hash, and removing events from the very end leaves a valid shorter chain.
 * To catch that, record `headHash` somewhere the database's owner cannot write (verify() returns it).
 *
 * In SQLite the table also refuses UPDATE and DELETE through triggers, so a bug in this program cannot rewrite
 * history. Retention does not touch it. Events are compact and carry no API keys, tokens or full transactions.
 */
export type AuditEventType = "evaluated" | "review_opened" | "review_resolved" | "approval_refused" | "signed" | "signing_failed"
  | "turnkey_approved" | "turnkey_rejected" | "turnkey_failed" | "turnkey_review_linked" | "turnkey_resolved";

export interface AuditEvent {
  /** Position in this customer's chain, starting at 1. */
  n: number;
  at: string;
  /** The customer id, or "open" for demo-mode traffic with no customer. */
  scope: string;
  type: AuditEventType;
  data: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  events: number;
  /** Hash of the newest event ("" when there are none). Store it outside the database to detect truncation. */
  headHash: string;
  /** First position that failed, and why. */
  brokenAt?: { n: number; reason: string };
}

export const GENESIS_HASH = "0".repeat(64);

/** JSON with sorted keys and bigint as strings, so the same event always hashes the same. */
export function canonicalize(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function hashEvent(e: Pick<AuditEvent, "n" | "at" | "scope" | "type" | "data" | "prevHash">): string {
  return createHash("sha256").update(canonicalize({ n: e.n, at: e.at, scope: e.scope, type: e.type, data: e.data, prev: e.prevHash })).digest("hex");
}

export interface Row { n: number; at: string; scope: string; type: string; data_json: string; prev_hash: string; hash: string }
export const eventFromRow = (r: Row): AuditEvent => ({ n: r.n, at: r.at, scope: r.scope, type: r.type as AuditEventType, data: JSON.parse(r.data_json) as Record<string, unknown>, prevHash: r.prev_hash, hash: r.hash });

export class AuditLog {
  private readonly database?: SqliteDatabase;
  private readonly memory = new Map<string, AuditEvent[]>();

  constructor(options: { persistencePath?: string } = {}) {
    if (!options.persistencePath) return;
    this.database = openSqliteDatabase(options.persistencePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        scope TEXT NOT NULL,
        n INTEGER NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (scope, n)
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS audit_events_no_update BEFORE UPDATE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_events_no_delete BEFORE DELETE ON audit_events
        BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
      CREATE INDEX IF NOT EXISTS audit_events_signing_by_review ON audit_events (scope, json_extract(data_json, '$.viaReview'), n)
        WHERE type IN ('signed', 'signing_failed');
      CREATE INDEX IF NOT EXISTS audit_events_refusal_by_review ON audit_events (scope, json_extract(data_json, '$.reviewId'), n)
        WHERE type = 'approval_refused';
    `);
  }

  /**
   * The newest signing outcome of a direct /gate-and-sign or /gate-and-sign-evm call that spent this review's
   * approval (`signed` or `signing_failed` naming it as viaReview), and the newest refused attempt to spend it.
   * Indexed: one lookup each, however long the history.
   */
  forReview(customerId: string | undefined, reviewId: string): { signing?: AuditEvent; refusal?: AuditEvent } {
    const scope = customerId ?? "open";
    if (this.database) {
      const signing = this.database.prepare(`SELECT n, at, scope, type, data_json, prev_hash, hash FROM audit_events
        WHERE type IN ('signed', 'signing_failed') AND scope = ? AND json_extract(data_json, '$.viaReview') = ? ORDER BY n DESC LIMIT 1`).get(scope, reviewId) as Row | undefined;
      const refusal = this.database.prepare(`SELECT n, at, scope, type, data_json, prev_hash, hash FROM audit_events
        WHERE type = 'approval_refused' AND scope = ? AND json_extract(data_json, '$.reviewId') = ? ORDER BY n DESC LIMIT 1`).get(scope, reviewId) as Row | undefined;
      return { signing: signing && eventFromRow(signing), refusal: refusal && eventFromRow(refusal) };
    }
    const events = this.memory.get(scope) ?? [];
    const newest = (match: (e: AuditEvent) => boolean) => { for (let i = events.length - 1; i >= 0; i--) if (match(events[i]!)) return events[i]; return undefined; };
    return {
      signing: newest((e) => (e.type === "signed" || e.type === "signing_failed") && e.data.viaReview === reviewId),
      refusal: newest((e) => e.type === "approval_refused" && e.data.reviewId === reviewId)
    };
  }

  private head(scope: string): { n: number; hash: string } {
    if (this.database) {
      const row = this.database.prepare("SELECT n, hash FROM audit_events WHERE scope = ? ORDER BY n DESC LIMIT 1").get(scope) as { n: number; hash: string } | undefined;
      return row ?? { n: 0, hash: GENESIS_HASH };
    }
    const last = this.memory.get(scope)?.at(-1);
    return last ? { n: last.n, hash: last.hash } : { n: 0, hash: GENESIS_HASH };
  }

  /** Appends one event to the customer's chain. `data` must be JSON-able (bigint becomes a string). */
  append(customerId: string | undefined, type: AuditEventType, data: Record<string, unknown>): AuditEvent {
    const scope = customerId ?? "open";
    const head = this.head(scope);
    // Normalise through JSON so what is hashed is exactly what is stored and later read back.
    const stored = JSON.parse(canonicalize(data)) as Record<string, unknown>;
    const partial = { n: head.n + 1, at: new Date().toISOString(), scope, type, data: stored, prevHash: head.hash };
    const event: AuditEvent = { ...partial, hash: hashEvent(partial) };
    if (this.database) {
      this.database.prepare("INSERT INTO audit_events (scope, n, at, type, data_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(event.scope, event.n, event.at, event.type, canonicalize(event.data), event.prevHash, event.hash);
    } else {
      const list = this.memory.get(scope) ?? [];
      list.push(event);
      this.memory.set(scope, list);
    }
    return event;
  }

  /** Events with position greater than `after`, oldest first. */
  list(customerId: string | undefined, options: { after?: number; limit?: number } = {}): AuditEvent[] {
    const scope = customerId ?? "open";
    const after = options.after ?? 0;
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1000);
    if (this.database) {
      return (this.database.prepare("SELECT n, at, scope, type, data_json, prev_hash, hash FROM audit_events WHERE scope = ? AND n > ? ORDER BY n ASC LIMIT ?").all(scope, after, limit) as Row[]).map(eventFromRow);
    }
    return (this.memory.get(scope) ?? []).filter((e) => e.n > after).slice(0, limit);
  }

  /** Recomputes the whole chain for one customer and reports the first break, if any. */
  verify(customerId: string | undefined): AuditVerification {
    const scope = customerId ?? "open";
    return verifyChain((after) => this.list(scope === "open" ? undefined : scope, { after, limit: 1000 }));
  }
}

/**
 * Recomputes one customer's chain from pages of events (oldest first, each page starting after the last position
 * of the previous one) and reports the first break. Shared by AuditLog.verify and the backup command.
 */
export function verifyChain(readPage: (after: number) => AuditEvent[]): AuditVerification {
  let prev = GENESIS_HASH;
  let expectedN = 1;
  let events = 0;
  for (let after = 0; ;) {
    const page = readPage(after);
    if (page.length === 0) break;
    for (const e of page) {
      const fail = (reason: string): AuditVerification => ({ ok: false, events, headHash: prev === GENESIS_HASH ? "" : prev, brokenAt: { n: e.n, reason } });
      if (e.n !== expectedN) return fail(`expected event ${expectedN} but found ${e.n} (an event is missing)`);
      if (e.prevHash !== prev) return fail("does not link to the previous event");
      if (hashEvent(e) !== e.hash) return fail("the event's contents do not match its hash");
      prev = e.hash;
      expectedN += 1;
      events += 1;
    }
    after = page.at(-1)!.n;
  }
  return { ok: true, events, headHash: events === 0 ? "" : prev };
}
