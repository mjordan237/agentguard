import { randomUUID } from "node:crypto";
import type { PolicyEvaluation } from "../policy/types.js";
import { deserializeStoredValue, openSqliteDatabase, serializeStoredValue, type SqliteDatabase } from "../storage/sqlite.js";

export interface EvaluationLogEntry {
  id: string;
  agentId: string;
  policyId: string;
  evaluation: PolicyEvaluation;
  recordedAt: string;
  /** Set when the request came from an authenticated customer; absent for open-mode (demo) traffic. */
  customerId?: string;
}

export interface EvaluationLogFilter {
  agentId?: string;
  decision?: PolicyEvaluation["decision"];
  limit?: number;
  /** When set, only this customer's entries. Always set it for authenticated requests. */
  customerId?: string;
}

export interface EvaluationLogOptions {
  /** When set, entries are persisted in this SQLite file. */
  persistencePath?: string;
}

interface StoredEntryRow {
  id: string;
  agent_id: string;
  policy_id: string;
  evaluation_json: string;
  recorded_at: string;
  customer_id: string | null;
}

/** Logs every /evaluate call, ALLOW included -- unlike PendingReviewStore, which only tracks NEEDS_REVIEW. */
export class EvaluationLog {
  private readonly entries: EvaluationLogEntry[] = [];
  private readonly database?: SqliteDatabase;

  constructor(options: EvaluationLogOptions = {}) {
    if (!options.persistencePath) return;
    this.database = openSqliteDatabase(options.persistencePath);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_log (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        policy_id TEXT NOT NULL,
        evaluation_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS evaluation_log_agent_recorded_at
        ON evaluation_log (agent_id, recorded_at DESC);
    `);
    // Databases created before customers existed have no customer_id column.
    const columns = this.database.prepare("PRAGMA table_info(evaluation_log)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "customer_id")) {
      this.database.exec("ALTER TABLE evaluation_log ADD COLUMN customer_id TEXT;");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS evaluation_log_customer_recorded_at ON evaluation_log (customer_id, recorded_at DESC);");
  }

  record(agentId: string, policyId: string, evaluation: PolicyEvaluation, customerId?: string): EvaluationLogEntry {
    const entry: EvaluationLogEntry = {
      id: randomUUID(),
      agentId,
      policyId,
      evaluation,
      recordedAt: new Date().toISOString(),
      customerId
    };
    if (this.database) {
      this.database.prepare(`
        INSERT INTO evaluation_log (id, agent_id, policy_id, evaluation_json, recorded_at, customer_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(entry.id, entry.agentId, entry.policyId, serializeStoredValue(entry.evaluation), entry.recordedAt, customerId ?? null);
    } else {
      this.entries.push(entry);
    }
    return entry;
  }

  /** With `customerId`, returns the entry only if that customer recorded it. */
  get(id: string, customerId?: string): EvaluationLogEntry | undefined {
    if (this.database) {
      const row = this.database.prepare(`
        SELECT id, agent_id, policy_id, evaluation_json, recorded_at, customer_id
        FROM evaluation_log WHERE id = ? ${customerId !== undefined ? "AND customer_id = ?" : ""}
      `).get(...(customerId !== undefined ? [id, customerId] : [id])) as StoredEntryRow | undefined;
      return row ? this.fromRow(row) : undefined;
    }
    return this.entries.find((entry) => entry.id === id && (customerId === undefined || entry.customerId === customerId));
  }

  query(filter: EvaluationLogFilter = {}): EvaluationLogEntry[] {
    // Most recent first -- observability is usually "what just happened", not archaeology.
    if (this.database) {
      // Filter and limit in SQL: this table has no size bound between prunes, so it must never be loaded whole.
      const { where, parameters } = this.whereClause(filter);
      const limit = filter.limit !== undefined && filter.limit >= 0 ? " LIMIT ?" : "";
      if (limit) parameters.push(Math.floor(filter.limit as number));
      const rows = this.database.prepare(`
        SELECT id, agent_id, policy_id, evaluation_json, recorded_at
        FROM evaluation_log ${where} ORDER BY recorded_at DESC, rowid DESC${limit}
      `).all(...parameters) as StoredEntryRow[];
      return rows.map((row) => this.fromRow(row));
    }
    let results = this.entries;
    if (filter.agentId !== undefined) results = results.filter((e) => e.agentId === filter.agentId);
    if (filter.customerId !== undefined) results = results.filter((e) => e.customerId === filter.customerId);
    if (filter.decision !== undefined) results = results.filter((e) => e.evaluation.decision === filter.decision);
    results = [...results].reverse();
    if (filter.limit !== undefined) results = results.slice(0, filter.limit);
    return results;
  }

  summaryByAgent(agentId: string, customerId?: string): { total: number; allow: number; needsReview: number } {
    if (this.database) {
      const row = this.database.prepare(`
        SELECT COUNT(*) AS total,
               COALESCE(SUM(json_extract(evaluation_json, '$.decision') = 'ALLOW'), 0) AS allow,
               COALESCE(SUM(json_extract(evaluation_json, '$.decision') = 'NEEDS_REVIEW'), 0) AS needs_review
        FROM evaluation_log WHERE agent_id = ? ${customerId !== undefined ? "AND customer_id = ?" : ""}
      `).get(...(customerId !== undefined ? [agentId, customerId] : [agentId])) as { total: number | bigint; allow: number | bigint; needs_review: number | bigint };
      return { total: Number(row.total), allow: Number(row.allow), needsReview: Number(row.needs_review) };
    }
    const forAgent = this.query({ agentId, customerId });
    return {
      total: forAgent.length,
      allow: forAgent.filter((e) => e.evaluation.decision === "ALLOW").length,
      needsReview: forAgent.filter((e) => e.evaluation.decision === "NEEDS_REVIEW").length
    };
  }

  /** Deletes up to `limit` entries recorded before `cutoffIso`. Returns how many were deleted. */
  pruneBatch(cutoffIso: string, limit: number): number {
    if (this.database) {
      const result = this.database.prepare(`
        DELETE FROM evaluation_log WHERE rowid IN (SELECT rowid FROM evaluation_log WHERE recorded_at < ? LIMIT ?)
      `).run(cutoffIso, limit);
      return Number(result.changes);
    }
    const before = this.entries.length;
    const kept = this.entries.filter((entry) => entry.recordedAt >= cutoffIso);
    this.entries.splice(0, before, ...kept);
    return before - kept.length;
  }

  private whereClause(filter: EvaluationLogFilter): { where: string; parameters: unknown[] } {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (filter.agentId !== undefined) { clauses.push("agent_id = ?"); parameters.push(filter.agentId); }
    if (filter.customerId !== undefined) { clauses.push("customer_id = ?"); parameters.push(filter.customerId); }
    if (filter.decision !== undefined) { clauses.push("json_extract(evaluation_json, '$.decision') = ?"); parameters.push(filter.decision); }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", parameters };
  }

  private fromRow(row: StoredEntryRow): EvaluationLogEntry {
    return {
      id: row.id,
      agentId: row.agent_id,
      policyId: row.policy_id,
      evaluation: deserializeStoredValue<PolicyEvaluation>(row.evaluation_json),
      recordedAt: row.recorded_at,
      customerId: row.customer_id ?? undefined
    };
  }
}
