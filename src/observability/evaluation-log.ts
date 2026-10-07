import { randomUUID } from "node:crypto";
import type { PolicyEvaluation } from "../policy/types.js";
import { deserializeStoredValue, openSqliteDatabase, serializeStoredValue, type SqliteDatabase } from "../storage/sqlite.js";

export interface EvaluationLogEntry {
  id: string;
  agentId: string;
  policyId: string;
  evaluation: PolicyEvaluation;
  recordedAt: string;
}

export interface EvaluationLogFilter {
  agentId?: string;
  decision?: PolicyEvaluation["decision"];
  limit?: number;
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
  }

  record(agentId: string, policyId: string, evaluation: PolicyEvaluation): EvaluationLogEntry {
    const entry: EvaluationLogEntry = {
      id: randomUUID(),
      agentId,
      policyId,
      evaluation,
      recordedAt: new Date().toISOString()
    };
    if (this.database) {
      this.database.prepare(`
        INSERT INTO evaluation_log (id, agent_id, policy_id, evaluation_json, recorded_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(entry.id, entry.agentId, entry.policyId, serializeStoredValue(entry.evaluation), entry.recordedAt);
    } else {
      this.entries.push(entry);
    }
    return entry;
  }

  get(id: string): EvaluationLogEntry | undefined {
    if (this.database) {
      const row = this.database.prepare(`
        SELECT id, agent_id, policy_id, evaluation_json, recorded_at
        FROM evaluation_log WHERE id = ?
      `).get(id) as StoredEntryRow | undefined;
      return row ? this.fromRow(row) : undefined;
    }
    return this.entries.find((entry) => entry.id === id);
  }

  query(filter: EvaluationLogFilter = {}): EvaluationLogEntry[] {
    let results = this.database
      ? (this.database.prepare(`
          SELECT id, agent_id, policy_id, evaluation_json, recorded_at
          FROM evaluation_log ORDER BY recorded_at ASC, rowid ASC
        `).all() as StoredEntryRow[]).map((row) => this.fromRow(row))
      : this.entries;
    if (filter.agentId !== undefined) results = results.filter((e) => e.agentId === filter.agentId);
    if (filter.decision !== undefined) results = results.filter((e) => e.evaluation.decision === filter.decision);
    // Most recent first -- observability is usually "what just happened", not archaeology.
    results = [...results].reverse();
    if (filter.limit !== undefined) results = results.slice(0, filter.limit);
    return results;
  }

  summaryByAgent(agentId: string): { total: number; allow: number; needsReview: number } {
    const forAgent = this.query({ agentId });
    return {
      total: forAgent.length,
      allow: forAgent.filter((e) => e.evaluation.decision === "ALLOW").length,
      needsReview: forAgent.filter((e) => e.evaluation.decision === "NEEDS_REVIEW").length
    };
  }

  private fromRow(row: StoredEntryRow): EvaluationLogEntry {
    return {
      id: row.id,
      agentId: row.agent_id,
      policyId: row.policy_id,
      evaluation: deserializeStoredValue<PolicyEvaluation>(row.evaluation_json),
      recordedAt: row.recorded_at
    };
  }
}
