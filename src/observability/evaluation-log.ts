import { randomUUID } from "node:crypto";
import type { PolicyEvaluation } from "../policy/types.js";

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

/**
 * Persistent (in-memory, for now) log of every transaction an agent
 * submitted for evaluation -- not just the ones that needed review.
 * This is the observability layer: what did every agent try to do,
 * when, and what was decided, queryable after the fact.
 *
 * This is the piece that turns ClearSign from "a policy check" into
 * "agent transaction safety infrastructure" in the sense Nosana's
 * Voight grant funds -- observability into what agents actually did,
 * not just a single pass/fail gate with no history.
 *
 * In-memory today; the query interface below is written so a real
 * database can replace the storage without changing callers.
 */
export class EvaluationLog {
  private readonly entries: EvaluationLogEntry[] = [];

  record(agentId: string, policyId: string, evaluation: PolicyEvaluation): EvaluationLogEntry {
    const entry: EvaluationLogEntry = {
      id: randomUUID(),
      agentId,
      policyId,
      evaluation,
      recordedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    return entry;
  }

  get(id: string): EvaluationLogEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  query(filter: EvaluationLogFilter = {}): EvaluationLogEntry[] {
    let results = this.entries;
    if (filter.agentId !== undefined) results = results.filter((e) => e.agentId === filter.agentId);
    if (filter.decision !== undefined) results = results.filter((e) => e.evaluation.decision === filter.decision);
    // Most recent first -- observability is usually "what just happened", not archaeology.
    results = [...results].reverse();
    if (filter.limit !== undefined) results = results.slice(0, filter.limit);
    return results;
  }

  summaryByAgent(agentId: string): { total: number; allow: number; needsReview: number } {
    const forAgent = this.entries.filter((e) => e.agentId === agentId);
    return {
      total: forAgent.length,
      allow: forAgent.filter((e) => e.evaluation.decision === "ALLOW").length,
      needsReview: forAgent.filter((e) => e.evaluation.decision === "NEEDS_REVIEW").length
    };
  }
}
