import type { SpendReservation } from "../policy/daily-spend-tracker.js";
import { deserializeStoredValue, openSqliteDatabase, serializeStoredValue, type SqliteDatabase } from "../storage/sqlite.js";

/**
 * Where AgentGuard is with one Turnkey signing request (the "signing activity"). AgentGuard's own approve or reject
 * vote is a second, separate Turnkey activity (the "vote activity"); its id and status are kept in the vote* fields.
 * - EVALUATING: claimed, being checked. Written before the check so a second poll or a restart does not start another.
 * - REVIEW_OPEN: waiting for a person (reviewId set).
 * - VOTING: the approval (if any) is spent and the budget reserved; the approve vote is being submitted. Written, with
 *   the vote's timestampMs, before it is sent, so a crash leaves a record that a vote may have gone out.
 * - VOTE_PENDING: Turnkey took the approve vote but its vote activity has not finished; that vote activity is queried.
 * - VOTE_UNKNOWN: whether the approve vote counted is not known. The budget stays reserved.
 * - REJECT_PENDING: AgentGuard decided to reject; the reject vote has not completed yet.
 * Vote finished, signing request still watched (read only, never voted on again):
 * - APPROVED: AgentGuard's approve vote activity completed. The signing activity may still need other approvers.
 * - VOTE_REFUSED: Turnkey refused the approve vote; the signing activity may still complete another way.
 * Terminal (the signing activity's outcome, or the end of observation): SIGNING_COMPLETED (Turnkey reports the signing
 * activity completed), REJECTED (AgentGuard's reject vote completed), RESOLVED_EXTERNALLY (rejected or failed without
 * AgentGuard deciding it), MISMATCH (the activity no longer matches what was recorded for it), SIGNING_UNRESOLVED
 * (Turnkey had not finished the signing activity when the observation horizon ended; left to an operator).
 * No state gives budget back once an approve vote may have been submitted (see TurnkeyApprover).
 */
export type LifecycleState =
  | "EVALUATING" | "REVIEW_OPEN" | "VOTING" | "VOTE_PENDING" | "VOTE_UNKNOWN" | "REJECT_PENDING"
  | "APPROVED" | "VOTE_REFUSED"
  | "SIGNING_COMPLETED" | "REJECTED" | "RESOLVED_EXTERNALLY" | "MISMATCH" | "SIGNING_UNRESOLVED";

const TERMINAL: readonly LifecycleState[] = ["SIGNING_COMPLETED", "REJECTED", "RESOLVED_EXTERNALLY", "MISMATCH", "SIGNING_UNRESOLVED"];
export const isTerminal = (state: LifecycleState) => TERMINAL.includes(state);

/**
 * Why AgentGuard holds the record. GUARD: a Solana signing request AgentGuard can read and judge. REJECT_ONLY: a request
 * on a guarded wallet AgentGuard can only refuse (an unsupported activity type, or a transaction it cannot read); it
 * has no transaction hash, never reaches a review, a charge or an approve vote, and exists so the reject vote is
 * recorded, backed off and bounded.
 */
export type ActivityPurpose = "GUARD" | "REJECT_ONLY";

/** One Turnkey activity, identified by organization and activity id, bound to the wallet, transaction and rules it was judged under. */
export interface ActivityRecord {
  organizationId: string;
  activityId: string;
  /** Turnkey's fingerprint of the signing activity: what a vote names. Not the vote activity's own fingerprint. */
  voteFingerprint: string;
  wallet: string;
  customerId?: string;
  agentId: string;
  policyId: string;
  /** The policy revision the activity was judged under; unset until the check finishes. */
  policyFingerprint?: string;
  /** SHA-256 of the transaction's message. Absent for REJECT_ONLY records, whose transaction could not be read. */
  transactionHash?: string;
  purpose: ActivityPurpose;
  reviewId?: string;
  state: LifecycleState;
  /** Budget reserved for this activity. */
  reservation?: SpendReservation;
  detail?: string;
  /** AgentGuard's latest vote on this signing activity: APPROVE or REJECT. */
  voteKind?: "APPROVE" | "REJECT";
  /** The timestampMs of that vote's request. Sending the identical body again returns the same vote activity. */
  voteTimestampMs?: string;
  /** Turnkey's id for that vote activity, once an answer named it. */
  voteActivityId?: string;
  /** The vote activity's last known status. */
  voteActivityStatus?: string;
  /** Distinct vote requests (distinct timestampMs) sent for this signing activity. Bounded. */
  voteSubmissions: number;
  /** Consecutive failed attempts to reach Turnkey for this record; sets the backoff. */
  retries: number;
  /** Do nothing for this record before this time (backoff after a failure or while a vote is pending). */
  nextCheckAt?: string;
  /** When AgentGuard stopped voting and began only reading the signing activity; the observation horizon counts from here. */
  watchSince?: string;
  createdAt: string;
  updatedAt: string;
}

export type ActivityUpdate = Partial<Pick<ActivityRecord, "state" | "reviewId" | "policyFingerprint" | "detail" | "voteSubmissions" | "retries">>
  & { reservation?: SpendReservation | null; voteKind?: "APPROVE" | "REJECT" | null; voteTimestampMs?: string | null; voteActivityId?: string | null; voteActivityStatus?: string | null; nextCheckAt?: string | null; watchSince?: string | null };

interface Row {
  organization_id: string; activity_id: string; vote_fingerprint: string; wallet: string; customer_id: string | null; agent_id: string;
  policy_id: string; policy_fingerprint: string | null; transaction_hash: string | null; review_id: string | null; state: LifecycleState;
  reservation_json: string | null; detail: string | null; created_at: string; updated_at: string;
  vote_kind: "APPROVE" | "REJECT" | null; vote_timestamp_ms: string | null; vote_activity_id: string | null; vote_activity_status: string | null;
  vote_submissions: number | null; retries: number | null; next_check_at: string | null; purpose: ActivityPurpose | null; watch_since: string | null;
}

const fromRow = (row: Row): ActivityRecord => ({
  organizationId: row.organization_id, activityId: row.activity_id, voteFingerprint: row.vote_fingerprint, wallet: row.wallet,
  customerId: row.customer_id ?? undefined, agentId: row.agent_id, policyId: row.policy_id, policyFingerprint: row.policy_fingerprint ?? undefined,
  transactionHash: row.transaction_hash ?? undefined, purpose: row.purpose ?? "GUARD", reviewId: row.review_id ?? undefined, state: row.state,
  reservation: row.reservation_json ? deserializeStoredValue<SpendReservation>(row.reservation_json) : undefined,
  detail: row.detail ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at,
  voteKind: row.vote_kind ?? undefined, voteTimestampMs: row.vote_timestamp_ms ?? undefined, voteActivityId: row.vote_activity_id ?? undefined,
  voteActivityStatus: row.vote_activity_status ?? undefined, voteSubmissions: Number(row.vote_submissions ?? 0), retries: Number(row.retries ?? 0),
  nextCheckAt: row.next_check_at ?? undefined, watchSince: row.watch_since ?? undefined
});

/** Columns added after the table was first released; each is added once, so starting twice is safe. */
const ADDED_COLUMNS: Array<[string, string]> = [
  ["vote_kind", "TEXT"], ["vote_timestamp_ms", "TEXT"], ["vote_activity_id", "TEXT"], ["vote_activity_status", "TEXT"],
  ["vote_submissions", "INTEGER NOT NULL DEFAULT 0"], ["retries", "INTEGER NOT NULL DEFAULT 0"], ["next_check_at", "TEXT"],
  ["purpose", "TEXT NOT NULL DEFAULT 'GUARD'"], ["watch_since", "TEXT"]
];

/** The table as it is now. transaction_hash is nullable: REJECT_ONLY records have none (see ActivityPurpose). */
const TABLE_COLUMNS = `
        organization_id TEXT NOT NULL,
        activity_id TEXT NOT NULL,
        vote_fingerprint TEXT NOT NULL,
        wallet TEXT NOT NULL,
        customer_id TEXT,
        agent_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        policy_fingerprint TEXT,
        transaction_hash TEXT,
        review_id TEXT,
        state TEXT NOT NULL,
        reservation_json TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        ${ADDED_COLUMNS.map(([name, type]) => `${name} ${type},`).join("\n        ")}
        PRIMARY KEY (organization_id, activity_id)`;
const INDEXES = `
      CREATE INDEX IF NOT EXISTS turnkey_activities_state_updated ON turnkey_activities (state, updated_at);
      CREATE INDEX IF NOT EXISTS turnkey_activities_review ON turnkey_activities (review_id) WHERE review_id IS NOT NULL;`;

/** The Turnkey activity lifecycle, in SQLite when a path is given and in memory otherwise, like the other stores. */
export class TurnkeyLifecycleStore {
  private readonly records = new Map<string, ActivityRecord>();
  private readonly leases = new Map<string, { owner: string; expiresAtMs: number; fence: number }>();
  private readonly database?: SqliteDatabase;

  constructor(options: { persistencePath?: string } = {}) {
    if (!options.persistencePath) return;
    this.database = openSqliteDatabase(options.persistencePath);
    this.database.exec(`CREATE TABLE IF NOT EXISTS turnkey_activities (${TABLE_COLUMNS}) STRICT;${INDEXES}`);
    this.database.exec("CREATE TABLE IF NOT EXISTS poller_lease (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, fence INTEGER NOT NULL DEFAULT 0) STRICT;");
    if (!new Set((this.database.prepare("PRAGMA table_info(poller_lease)").all() as Array<{ name: string }>).map((c) => c.name)).has("fence")) {
      this.database.exec("ALTER TABLE poller_lease ADD COLUMN fence INTEGER NOT NULL DEFAULT 0;");
    }
    const columns = new Set((this.database.prepare("PRAGMA table_info(turnkey_activities)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const [name, type] of ADDED_COLUMNS) if (!columns.has(name)) this.database.exec(`ALTER TABLE turnkey_activities ADD COLUMN ${name} ${type};`);
    this.relaxTransactionHash(this.database);
  }

  /**
   * Tables created before REJECT_ONLY records declared transaction_hash NOT NULL, which SQLite cannot drop in place:
   * copy the rows into a table without it, in one transaction, re-checked inside it so concurrent starts do it once.
   */
  private relaxTransactionHash(database: SqliteDatabase): void {
    const strict = () => (database.prepare("PRAGMA table_info(turnkey_activities)").all() as Array<{ name: string; notnull: number }>)
      .some((column) => column.name === "transaction_hash" && column.notnull === 1);
    if (!strict()) return;
    database.exec("BEGIN IMMEDIATE;");
    try {
      if (strict()) {
        const names = (database.prepare("PRAGMA table_info(turnkey_activities)").all() as Array<{ name: string }>).map((c) => c.name).join(", ");
        database.exec(`
          CREATE TABLE turnkey_activities_rebuilt (${TABLE_COLUMNS}) STRICT;
          INSERT INTO turnkey_activities_rebuilt (${names}) SELECT ${names} FROM turnkey_activities;
          DROP TABLE turnkey_activities;
          ALTER TABLE turnkey_activities_rebuilt RENAME TO turnkey_activities;
          ${INDEXES}
        `);
      }
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  /**
   * Single-active-poller lease. Only one owner holds `name` at a time, so when the approver runs against this shared
   * database from more than one process only the holder advances the lifecycle and the others stand by: the approver's
   * vote submission is a read-check-write (read the vote count and timestamp, decide, submit, write) that is not one
   * cross-connection transaction, so two concurrent pollers could otherwise each submit a distinct vote activity for
   * the same signing request. The read of the current holder, the expiry check and the write are one BEGIN IMMEDIATE
   * transaction, so two processes cannot both acquire against the same earlier state. The holder renews by acquiring
   * again (its own owner always succeeds); a holder that stops renewing lets the lease lapse after ttlMs and another
   * process takes it over. In memory there is only one process, so an owner that is free to the caller is granted.
   *
   * A monotonic fence token advances every time a DIFFERENT owner takes the lease over (never on a same-owner renewal)
   * and survives a release, so a holder can later tell whether anyone took over while it was paused: see assertLease.
   */
  acquireLease(name: string, owner: string, nowMs: number, ttlMs: number): boolean {
    if (this.database) {
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        const row = this.database.prepare("SELECT owner, expires_at_ms, fence FROM poller_lease WHERE name = ?").get(name) as { owner: string; expires_at_ms: number | bigint; fence: number | bigint } | undefined;
        const free = !row || row.owner === owner || Number(row.expires_at_ms) <= nowMs;
        if (free) {
          const fence = !row ? 1 : row.owner === owner ? Number(row.fence) : Number(row.fence) + 1;
          this.database.prepare("INSERT INTO poller_lease (name, owner, expires_at_ms, fence) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at_ms = excluded.expires_at_ms, fence = excluded.fence").run(name, owner, nowMs + ttlMs, fence);
        }
        this.database.exec("COMMIT;");
        return free;
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
    }
    const held = this.leases.get(name);
    const free = !held || held.owner === owner || held.expiresAtMs <= nowMs;
    if (free) this.leases.set(name, { owner, expiresAtMs: nowMs + ttlMs, fence: !held ? 1 : held.owner === owner ? held.fence : held.fence + 1 });
    return free;
  }

  /** The current fence token of a lease, or 0 if it has never been held. Capture it right after a successful acquire. */
  leaseFence(name: string): number {
    if (this.database) {
      const row = this.database.prepare("SELECT fence FROM poller_lease WHERE name = ?").get(name) as { fence: number | bigint } | undefined;
      return row ? Number(row.fence) : 0;
    }
    return this.leases.get(name)?.fence ?? 0;
  }

  /**
   * True only if `owner` still holds `name` at the exact `fence` it captured when it acquired. If another owner took
   * the lease over in the meantime the fence has advanced (and does not reset on release), so this returns false even
   * if that other owner has since released it. This lets a holder that resumes after a pause detect that it was
   * superseded before it does anything privileged, without wrongly standing down when its own lease merely lapsed with
   * no one else taking over (the fence is unchanged then).
   */
  assertLease(name: string, owner: string, fence: number): boolean {
    if (this.database) {
      const row = this.database.prepare("SELECT owner, fence FROM poller_lease WHERE name = ?").get(name) as { owner: string; fence: number | bigint } | undefined;
      return !!row && row.owner === owner && Number(row.fence) === fence;
    }
    const held = this.leases.get(name);
    return !!held && held.owner === owner && held.fence === fence;
  }

  /** Gives up a lease so a standby poller can take over at once, rather than waiting for it to lapse. The fence token
   * is kept (the row is only marked expired), so a superseded holder that resumes still sees the advance. */
  releaseLease(name: string, owner: string): void {
    if (this.database) {
      this.database.prepare("UPDATE poller_lease SET expires_at_ms = 0 WHERE name = ? AND owner = ?").run(name, owner);
      return;
    }
    const held = this.leases.get(name);
    if (held?.owner === owner) held.expiresAtMs = 0;
  }

  private key(organizationId: string, activityId: string) { return `${organizationId}\u0000${activityId}`; }

  get(organizationId: string, activityId: string): ActivityRecord | undefined {
    if (this.database) {
      const row = this.database.prepare("SELECT * FROM turnkey_activities WHERE organization_id = ? AND activity_id = ?").get(organizationId, activityId) as Row | undefined;
      return row ? fromRow(row) : undefined;
    }
    const record = this.records.get(this.key(organizationId, activityId));
    return record ? { ...record } : undefined;
  }

  /** The activity each review was opened for, in one query. A review is opened for at most one activity (its origin key). */
  byReviewIds(reviewIds: readonly string[]): Map<string, ActivityRecord> {
    const found = new Map<string, ActivityRecord>();
    if (reviewIds.length === 0) return found;
    if (this.database) {
      const rows = this.database.prepare(`SELECT * FROM turnkey_activities WHERE review_id IN (${reviewIds.map(() => "?").join(", ")})`).all(...reviewIds) as Row[];
      for (const row of rows) found.set(row.review_id!, fromRow(row));
      return found;
    }
    const wanted = new Set(reviewIds);
    for (const record of this.records.values()) if (record.reviewId && wanted.has(record.reviewId)) found.set(record.reviewId, { ...record });
    return found;
  }

  /** Records a new activity as EVALUATING. False if it is already recorded: someone else has it, so leave it alone. */
  claim(input: Omit<ActivityRecord, "state" | "createdAt" | "updatedAt" | "voteSubmissions" | "retries" | "purpose"> & { purpose?: ActivityPurpose }): boolean {
    const record = { ...input, purpose: input.purpose ?? "GUARD" as ActivityPurpose };
    const now = new Date().toISOString();
    if (this.database) {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO turnkey_activities (organization_id, activity_id, vote_fingerprint, wallet, customer_id, agent_id, policy_id, policy_fingerprint, transaction_hash, purpose, review_id, state, reservation_json, detail, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'EVALUATING', NULL, NULL, ?, ?)
      `).run(record.organizationId, record.activityId, record.voteFingerprint, record.wallet, record.customerId ?? null, record.agentId, record.policyId, record.policyFingerprint ?? null, record.transactionHash ?? null, record.purpose, now, now);
      return Number(result.changes) > 0;
    }
    const key = this.key(record.organizationId, record.activityId);
    if (this.records.has(key)) return false;
    this.records.set(key, { ...record, state: "EVALUATING", voteSubmissions: 0, retries: 0, createdAt: now, updatedAt: now });
    return true;
  }

  update(organizationId: string, activityId: string, update: ActivityUpdate): void {
    const now = new Date().toISOString();
    if (this.database) {
      const sets: string[] = ["updated_at = ?"];
      const values: unknown[] = [now];
      if (update.state !== undefined) { sets.push("state = ?"); values.push(update.state); }
      if (update.reviewId !== undefined) { sets.push("review_id = ?"); values.push(update.reviewId); }
      if (update.policyFingerprint !== undefined) { sets.push("policy_fingerprint = ?"); values.push(update.policyFingerprint); }
      if (update.detail !== undefined) { sets.push("detail = ?"); values.push(update.detail); }
      if (update.reservation !== undefined) { sets.push("reservation_json = ?"); values.push(update.reservation === null ? null : serializeStoredValue(update.reservation)); }
      const plain: Array<[keyof ActivityUpdate, string]> = [["voteKind", "vote_kind"], ["voteTimestampMs", "vote_timestamp_ms"], ["voteActivityId", "vote_activity_id"],
        ["voteActivityStatus", "vote_activity_status"], ["voteSubmissions", "vote_submissions"], ["retries", "retries"], ["nextCheckAt", "next_check_at"], ["watchSince", "watch_since"]];
      for (const [field, column] of plain) if (update[field] !== undefined) { sets.push(`${column} = ?`); values.push(update[field] as string | number | null); }
      this.database.prepare(`UPDATE turnkey_activities SET ${sets.join(", ")} WHERE organization_id = ? AND activity_id = ?`).run(...values, organizationId, activityId);
      return;
    }
    const record = this.records.get(this.key(organizationId, activityId));
    if (!record) return;
    for (const [field, value] of Object.entries(update)) {
      if (value === undefined) continue;
      (record as unknown as Record<string, unknown>)[field] = value === null ? undefined : value;
    }
    record.updatedAt = now;
  }

  /** Records not yet finished, least recently touched first, so a capped pass reaches every one in turn. */
  unresolved(limit: number): ActivityRecord[] {
    if (this.database) {
      const placeholders = TERMINAL.map(() => "?").join(", ");
      return (this.database.prepare(`SELECT * FROM turnkey_activities WHERE state NOT IN (${placeholders}) ORDER BY updated_at LIMIT ?`).all(...TERMINAL, limit) as Row[]).map(fromRow);
    }
    return [...this.records.values()].filter((record) => !isTerminal(record.state)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, limit).map((record) => ({ ...record }));
  }

  /**
   * Retention: deletes finished records last touched before the cutoff. Unfinished ones are kept. A charge kept for a
   * finished record lives in the spend ledger, by day, so deleting the record never gives budget back.
   */
  pruneBatch(cutoffIso: string, limit: number): number {
    if (this.database) {
      const placeholders = TERMINAL.map(() => "?").join(", ");
      const result = this.database.prepare(`DELETE FROM turnkey_activities WHERE rowid IN (SELECT rowid FROM turnkey_activities WHERE state IN (${placeholders}) AND updated_at < ? LIMIT ?)`).run(...TERMINAL, cutoffIso, limit);
      return Number(result.changes);
    }
    let removed = 0;
    for (const [key, record] of this.records) {
      if (removed >= limit) break;
      if (isTerminal(record.state) && record.updatedAt < cutoffIso) { this.records.delete(key); removed++; }
    }
    return removed;
  }
}
