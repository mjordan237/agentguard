import { randomUUID } from "node:crypto";
import type { PolicyEvaluation } from "../policy/types.js";
import type { ReviewExplanation } from "../analysis/nemotron-explainer.js";
import { deserializeStoredValue, openSqliteDatabase, serializeStoredValue, type SqliteDatabase } from "../storage/sqlite.js";

/** Who approved or denied a review. "shared-secret" means the legacy single secret was used, so no individual is identified. */
export type ResolutionActor =
  | { kind: "reviewer"; id: string; name: string }
  | { kind: "shared-secret" };

export type ReviewStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

export interface PendingReview {
  id: string;
  agentId: string;
  evaluation: PolicyEvaluation;
  status: ReviewStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  /** Advisory model-written note. Never consulted for any decision. */
  explanation?: ReviewExplanation;
  /** Set only when this review was approved or denied; absent for expired reviews. */
  resolvedBy?: ResolutionActor;
  /** The customer whose request created this review; absent in open mode. Customer-scoped reviewers can act only on their own customer's reviews. */
  customerId?: string;
  /** SHA-256 of the reviewed transaction's message. An approval can sign only a transaction with this hash. */
  transactionHash?: string;
  /** The policy the transaction was evaluated under. An approval can be used only under the same policy. */
  policyId?: string;
  /** SHA-256 of that policy's rules when the review opened (see policyFingerprint). An approval is void once they change. */
  policyFingerprint?: string;
  /** Set once an approval has been used to sign. An approval is single-use. */
  consumedAt?: string;
  /** What spent the approval, when the caller named itself (a Turnkey activity). Lets that caller prove it after a crash. */
  consumedBy?: string;
  /** "solana", or "evm:<chain id>" ("evm" if the request named none). Absent for reviews stored before it was recorded. */
  chain?: string;
}

/** Which reviews a caller may see: one customer's, or all of them (operator reviewers and the shared secret). */
export type ReviewScope = { customerId: string } | "all";

export interface ReviewListQuery {
  scope: ReviewScope;
  status?: ReviewStatus;
  agentId?: string;
  /** "solana", "evm" (any EVM chain), "evm:<id>", or "unknown" for reviews with no recorded chain. */
  chain?: string;
  limit: number;
  /** The last review of the previous page. Pages run newest first, ties broken by id. */
  after?: { createdAt: string; id: string };
}

/** Why an approval could not be used to sign. "policy_changed": the policy's rules are not the revision that was reviewed. */
export type ConsumeOutcome = "ok" | "not_found" | "not_approved" | "mismatch" | "already_used" | "stale" | "policy_changed";

/** What one approve/deny request did (see resolveOutcome). */
export type ResolveOutcome = "applied" | "already_decided" | "expired" | "not_found";

/** Whether an approval was spent by a given caller and would still be valid for it (see spentBy). */
export type SpentByOutcome = "ok" | "not_found" | "not_approved" | "not_consumed" | "consumed_elsewhere" | "mismatch" | "stale" | "policy_changed";

/** Who is spending an approval and under which rules. Required: an approval is never spent without being matched to all of it. */
export interface ApprovalContext {
  agentId: string;
  policyId: string;
  policyFingerprint: string;
}

export interface PendingReviewStoreOptions {
  /** Pending reviews become non-actionable after this interval. Defaults to 15 minutes. */
  expiresInMs?: number;
  /** When set, reviews are persisted in this SQLite file. */
  persistencePath?: string;
}

interface StoredReviewRow {
  id: string;
  agent_id: string;
  evaluation_json: string;
  status: ReviewStatus;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  customer_id: string | null;
  transaction_hash: string | null;
  consumed_at: string | null;
  policy_id: string | null;
  policy_fingerprint: string | null;
  consumed_by: string | null;
  chain: string | null;
}

/**
 * Stores transaction reviews, reviewer attribution and approval consumption.
 * Uses SQLite when persistencePath is configured, otherwise process-local memory.
 */
export class PendingReviewStore {
  private readonly reviews = new Map<string, PendingReview>();
  /** In memory: origin key to review id (see createForOrigin). */
  private readonly origins = new Map<string, string>();
  private readonly expiresInMs: number;
  private readonly database?: SqliteDatabase;

  constructor(options: PendingReviewStoreOptions = {}) {
    this.expiresInMs = options.expiresInMs ?? 15 * 60_000;
    if (!Number.isFinite(this.expiresInMs) || this.expiresInMs <= 0) {
      throw new Error("Review expiry must be a positive finite number of milliseconds.");
    }
    if (options.persistencePath) {
      this.database = openSqliteDatabase(options.persistencePath);
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS pending_reviews (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          evaluation_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DENIED', 'EXPIRED')),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          resolved_at TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS pending_reviews_status_expires_at
          ON pending_reviews (status, expires_at);
        CREATE TABLE IF NOT EXISTS review_resolutions (
          review_id TEXT PRIMARY KEY,
          actor_json TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS review_explanations (
          review_id TEXT PRIMARY KEY,
          explanation_json TEXT NOT NULL
        ) STRICT;
      `);
      const columns = this.database.prepare("PRAGMA table_info(pending_reviews)").all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "customer_id")) this.database.exec("ALTER TABLE pending_reviews ADD COLUMN customer_id TEXT;");
      if (!columns.some((column) => column.name === "transaction_hash")) this.database.exec("ALTER TABLE pending_reviews ADD COLUMN transaction_hash TEXT;");
      if (!columns.some((column) => column.name === "consumed_at")) this.database.exec("ALTER TABLE pending_reviews ADD COLUMN consumed_at TEXT;");
      if (!columns.some((column) => column.name === "policy_id")) this.database.exec("ALTER TABLE pending_reviews ADD COLUMN policy_id TEXT;");
      if (!columns.some((column) => column.name === "policy_fingerprint")) this.database.exec("ALTER TABLE pending_reviews ADD COLUMN policy_fingerprint TEXT;");
      if (!columns.some((column) => column.name === "origin_key")) this.database.exec("ALTER TABLE pending_reviews ADD COLUMN origin_key TEXT;");
      if (!columns.some((column) => column.name === "consumed_by")) this.database.exec("ALTER TABLE pending_reviews ADD COLUMN consumed_by TEXT;");
      if (!columns.some((column) => column.name === "chain")) this.database.exec("ALTER TABLE pending_reviews ADD COLUMN chain TEXT;");
      // For list(): newest first within a customer and status, with the id as tie-breaker.
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS pending_reviews_list ON pending_reviews (created_at, id);
        CREATE INDEX IF NOT EXISTS pending_reviews_list_status ON pending_reviews (status, created_at, id);
        CREATE INDEX IF NOT EXISTS pending_reviews_list_customer ON pending_reviews (customer_id, created_at, id);
        CREATE INDEX IF NOT EXISTS pending_reviews_list_customer_status ON pending_reviews (customer_id, status, created_at, id);
      `);
      this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS pending_reviews_origin_key ON pending_reviews (origin_key) WHERE origin_key IS NOT NULL;");
    }
  }

  create(agentId: string, evaluation: PolicyEvaluation, customerId?: string, transactionHash?: string, policyId?: string, policyFingerprint?: string, chain?: string): PendingReview {
    const createdAt = new Date();
    const review: PendingReview = {
      id: randomUUID(),
      agentId,
      evaluation,
      status: "PENDING",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.expiresInMs).toISOString(),
      customerId,
      transactionHash,
      policyId,
      policyFingerprint,
      chain
    };
    if (this.database) {
      this.database.prepare(`
        INSERT INTO pending_reviews (id, agent_id, evaluation_json, status, created_at, expires_at, resolved_at, customer_id, transaction_hash, policy_id, policy_fingerprint, chain)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        review.id,
        review.agentId,
        serializeStoredValue(review.evaluation),
        review.status,
        review.createdAt,
        review.expiresAt,
        null,
        review.customerId ?? null,
        review.transactionHash ?? null,
        review.policyId ?? null,
        review.policyFingerprint ?? null,
        review.chain ?? null
      );
    } else {
      this.reviews.set(review.id, review);
    }
    return review;
  }

  /**
   * Opens the review for something that must only ever have one, named by `originKey` (a Turnkey activity), or
   * returns the one already opened for it. Check and insert are one transaction, and the key is unique in the
   * table, so a retry after a crash finds the first review instead of opening a second.
   */
  createForOrigin(originKey: string, agentId: string, evaluation: PolicyEvaluation, customerId?: string, transactionHash?: string, policyId?: string, policyFingerprint?: string, chain?: string): { review: PendingReview; created: boolean } {
    if (this.database) {
      this.database.exec("BEGIN IMMEDIATE;");
      let id: string;
      let created = false;
      try {
        const existing = this.database.prepare("SELECT id FROM pending_reviews WHERE origin_key = ?").get(originKey) as { id: string } | undefined;
        if (existing) id = existing.id;
        else {
          id = this.create(agentId, evaluation, customerId, transactionHash, policyId, policyFingerprint, chain).id;
          this.database.prepare("UPDATE pending_reviews SET origin_key = ? WHERE id = ?").run(originKey, id);
          created = true;
        }
        this.database.exec("COMMIT;");
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
      return { review: this.get(id)!, created };
    }
    const existing = this.origins.get(originKey);
    if (existing && this.reviews.has(existing)) return { review: this.get(existing)!, created: false };
    const review = this.create(agentId, evaluation, customerId, transactionHash, policyId, policyFingerprint, chain);
    this.origins.set(originKey, review.id);
    return { review, created: true };
  }

  /**
   * One page of reviews for the operator queue, newest first, with who resolved each. Scoping and filters are
   * part of the query, so another customer's reviews are never read. A pending review past its expiry is listed
   * as EXPIRED, as get() would report it; listing writes nothing. AI explanations are not loaded.
   */
  list(query: ReviewListQuery): { reviews: PendingReview[]; more: boolean } {
    const limit = Math.min(Math.max(Math.trunc(query.limit), 1), 100);
    const now = new Date().toISOString();
    if (this.database) {
      const where: string[] = [];
      const values: Array<string | number> = [];
      if (query.scope !== "all") { where.push("r.customer_id = ?"); values.push(query.scope.customerId); }
      if (query.status === "PENDING") { where.push("r.status = 'PENDING' AND r.expires_at > ?"); values.push(now); }
      else if (query.status === "EXPIRED") { where.push("(r.status = 'EXPIRED' OR (r.status = 'PENDING' AND r.expires_at <= ?))"); values.push(now); }
      else if (query.status) { where.push("r.status = ?"); values.push(query.status); }
      if (query.agentId !== undefined) { where.push("r.agent_id = ?"); values.push(query.agentId); }
      if (query.chain === "unknown") where.push("r.chain IS NULL");
      else if (query.chain === "evm") where.push("(r.chain = 'evm' OR r.chain LIKE 'evm:%')");
      else if (query.chain !== undefined) { where.push("r.chain = ?"); values.push(query.chain); }
      if (query.after) { where.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))"); values.push(query.after.createdAt, query.after.createdAt, query.after.id); }
      const rows = this.database.prepare(`
        SELECT r.id, r.agent_id, r.evaluation_json,
          CASE WHEN r.status = 'PENDING' AND r.expires_at <= ? THEN 'EXPIRED' ELSE r.status END AS status,
          r.created_at, r.expires_at, r.resolved_at, r.customer_id, r.transaction_hash, r.consumed_at, r.policy_id, r.policy_fingerprint, r.consumed_by, r.chain,
          res.actor_json
        FROM pending_reviews r LEFT JOIN review_resolutions res ON res.review_id = r.id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY r.created_at DESC, r.id DESC LIMIT ?
      `).all(now, ...values, limit + 1) as Array<StoredReviewRow & { actor_json: string | null }>;
      const reviews = rows.slice(0, limit).map((row) => {
        const review = this.fromRow(row);
        if (row.actor_json) review.resolvedBy = JSON.parse(row.actor_json) as ResolutionActor;
        return review;
      });
      return { reviews, more: rows.length > limit };
    }
    const matching = [...this.reviews.values()].filter((review) => {
      this.expireIfNeeded(review);
      if (query.scope !== "all" && review.customerId !== query.scope.customerId) return false;
      if (query.status && review.status !== query.status) return false;
      if (query.agentId !== undefined && review.agentId !== query.agentId) return false;
      if (query.chain === "unknown" ? review.chain !== undefined : query.chain === "evm" ? !(review.chain === "evm" || review.chain?.startsWith("evm:")) : query.chain !== undefined && review.chain !== query.chain) return false;
      if (query.after && !(review.createdAt < query.after.createdAt || (review.createdAt === query.after.createdAt && review.id < query.after.id))) return false;
      return true;
    }).sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    return { reviews: matching.slice(0, limit).map((review) => ({ ...review, explanation: undefined })), more: matching.length > limit };
  }

  /** Attaches an advisory explanation. No-op for an unknown review; never changes status. */
  attachExplanation(id: string, explanation: ReviewExplanation): void {
    if (this.database) {
      const exists = this.database.prepare("SELECT 1 FROM pending_reviews WHERE id = ?").get(id);
      if (!exists) return;
      this.database.prepare("INSERT OR REPLACE INTO review_explanations (review_id, explanation_json) VALUES (?, ?)")
        .run(id, JSON.stringify(explanation));
      return;
    }
    const review = this.reviews.get(id);
    if (review) review.explanation = explanation;
  }

  get(id: string): PendingReview | undefined {
    if (this.database) {
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE pending_reviews SET status = 'EXPIRED'
        WHERE id = ? AND status = 'PENDING' AND expires_at <= ?
      `).run(id, now);
      const row = this.database.prepare(`
        SELECT id, agent_id, evaluation_json, status, created_at, expires_at, resolved_at, customer_id, transaction_hash, consumed_at, policy_id, policy_fingerprint, consumed_by, chain
        FROM pending_reviews WHERE id = ?
      `).get(id) as StoredReviewRow | undefined;
      if (!row) return undefined;
      const review = this.fromRow(row);
      const stored = this.database.prepare("SELECT explanation_json FROM review_explanations WHERE review_id = ?")
        .get(id) as { explanation_json: string } | undefined;
      if (stored) review.explanation = JSON.parse(stored.explanation_json) as ReviewExplanation;
      const resolution = this.database.prepare("SELECT actor_json FROM review_resolutions WHERE review_id = ?")
        .get(id) as { actor_json: string } | undefined;
      if (resolution) review.resolvedBy = JSON.parse(resolution.actor_json) as ResolutionActor;
      return review;
    }
    const review = this.reviews.get(id);
    if (!review) return undefined;
    this.expireIfNeeded(review);
    return review;
  }

  /**
   * Approves or denies a pending review and records who did it. Only the call
   * that actually changes the status records an actor, so a later attempt on an
   * already-resolved review can never overwrite the original attribution.
   */
  resolve(id: string, status: "APPROVED" | "DENIED", actor: ResolutionActor): PendingReview | undefined {
    return this.resolveOutcome(id, status, actor).review;
  }

  /**
   * As resolve(), and says whether this call made the change. "applied" comes from the same transaction as the
   * transition (the conditional UPDATE changed a row), so of any number of concurrent callers, in this process or
   * others sharing the database, exactly one gets it. "already_decided" means someone else's decision stands;
   * "expired" that the review ran out first.
   */
  resolveOutcome(id: string, status: "APPROVED" | "DENIED", actor: ResolutionActor): { outcome: ResolveOutcome; review?: PendingReview } {
    if (this.database) {
      const now = new Date().toISOString();
      let applied = false;
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        this.database.prepare(`
          UPDATE pending_reviews SET status = 'EXPIRED'
          WHERE id = ? AND status = 'PENDING' AND expires_at <= ?
        `).run(id, now);
        const changed = this.database.prepare(`
          UPDATE pending_reviews SET status = ?, resolved_at = ?
          WHERE id = ? AND status = 'PENDING' AND expires_at > ?
        `).run(status, now, id, now);
        applied = Number(changed.changes) > 0;
        if (applied) {
          this.database.prepare("INSERT INTO review_resolutions (review_id, actor_json) VALUES (?, ?)")
            .run(id, JSON.stringify(actor));
        }
        this.database.exec("COMMIT;");
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
      const review = this.get(id);
      return { outcome: applied ? "applied" : !review ? "not_found" : review.status === "EXPIRED" ? "expired" : "already_decided", review };
    }
    const review = this.get(id);
    if (!review) return { outcome: "not_found" };
    if (review.status === "EXPIRED") return { outcome: "expired", review };
    if (review.status !== "PENDING") return { outcome: "already_decided", review }; // already resolved, don't flip it again
    review.status = status;
    review.resolvedAt = new Date().toISOString();
    review.resolvedBy = actor;
    return { outcome: "applied", review };
  }

  /**
   * Spends an approval to sign one transaction. Succeeds only if the review is APPROVED, belongs to
   * `customerId` (both undefined in open mode), was approved no more than the review window ago, has not
   * been used, was created for a transaction with exactly this message hash, and was opened for the same
   * agent, policy and revision of that policy's rules. Reviews stored before revisions were recorded have
   * none, so they answer "policy_changed" and the transaction must be reviewed again. Atomic: of two
   * concurrent calls, one gets "ok". `consumer`, if given, is recorded as what spent it (see spentBy).
   */
  consumeApproved(id: string, transactionHash: string | undefined, customerId: string | undefined, context: ApprovalContext, consumer?: string): ConsumeOutcome {
    const check = (review: PendingReview): ConsumeOutcome => {
      if ((review.customerId ?? undefined) !== customerId) return "not_found"; // another customer's review looks missing
      if (review.status !== "APPROVED") return "not_approved";
      if (review.consumedAt) return "already_used";
      return this.validFor(review, transactionHash, context);
    };
    if (this.database) {
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        const row = this.database.prepare(`
          SELECT id, agent_id, evaluation_json, status, created_at, expires_at, resolved_at, customer_id, transaction_hash, consumed_at, policy_id, policy_fingerprint, consumed_by, chain
          FROM pending_reviews WHERE id = ?
        `).get(id) as StoredReviewRow | undefined;
        const outcome = row ? check(this.fromRow(row)) : "not_found";
        if (outcome === "ok") this.database.prepare("UPDATE pending_reviews SET consumed_at = ?, consumed_by = ? WHERE id = ?").run(new Date().toISOString(), consumer ?? null, id);
        this.database.exec("COMMIT;");
        return outcome;
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
    }
    const review = this.reviews.get(id);
    const outcome = review ? check(review) : "not_found";
    if (outcome === "ok" && review) { review.consumedAt = new Date().toISOString(); review.consumedBy = consumer; }
    return outcome;
  }

  /**
   * For a caller recovering from a crash after consumeApproved: "ok" only if `consumer` itself spent this approval
   * and every other condition of consumeApproved still holds (customer, transaction, agent, policy, revision,
   * freshness). Approvals spent without a recorded consumer, including all spent before it was recorded, answer
   * "consumed_elsewhere". Read-only.
   */
  spentBy(id: string, transactionHash: string | undefined, customerId: string | undefined, context: ApprovalContext, consumer: string): SpentByOutcome {
    const review = this.get(id);
    if (!review || (review.customerId ?? undefined) !== customerId) return "not_found";
    if (review.status !== "APPROVED") return "not_approved";
    if (!review.consumedAt) return "not_consumed";
    if (review.consumedBy !== consumer) return "consumed_elsewhere";
    return this.validFor(review, transactionHash, context);
  }

  /** The checks an approved review must pass for this transaction, caller and rules, whoever spends it. */
  private validFor(review: PendingReview, transactionHash: string | undefined, context: ApprovalContext): "ok" | "mismatch" | "policy_changed" | "stale" {
    if (!transactionHash || review.transactionHash !== transactionHash) return "mismatch"; // no hash on either side can never match
    if (review.agentId !== context.agentId || review.policyId !== context.policyId) return "mismatch";
    if (!review.policyFingerprint || review.policyFingerprint !== context.policyFingerprint) return "policy_changed";
    if (review.resolvedAt && Date.now() - Date.parse(review.resolvedAt) > this.expiresInMs) return "stale";
    return "ok";
  }

  /** Gives an approval back after signing failed. Safe because the same message always produces the same transaction, which the chain accepts once. */
  releaseConsumed(id: string): void {
    if (this.database) {
      this.database.prepare("UPDATE pending_reviews SET consumed_at = NULL, consumed_by = NULL WHERE id = ?").run(id);
      return;
    }
    const review = this.reviews.get(id);
    if (review) { review.consumedAt = undefined; review.consumedBy = undefined; }
  }

  /**
   * Deletes up to `limit` reviews whose expiry passed before `cutoffIso`, with their explanations and
   * resolution records. Such reviews can no longer be acted on, whatever their status. Returns the count.
   */
  pruneBatch(cutoffIso: string, limit: number): number {
    if (this.database) {
      this.database.exec("BEGIN IMMEDIATE;");
      try {
        const ids = (this.database.prepare("SELECT id FROM pending_reviews WHERE expires_at < ? LIMIT ?")
          .all(cutoffIso, limit) as Array<{ id: string }>).map((row) => row.id);
        for (const id of ids) {
          this.database.prepare("DELETE FROM review_explanations WHERE review_id = ?").run(id);
          this.database.prepare("DELETE FROM review_resolutions WHERE review_id = ?").run(id);
          this.database.prepare("DELETE FROM pending_reviews WHERE id = ?").run(id);
        }
        this.database.exec("COMMIT;");
        return ids.length;
      } catch (error) {
        this.database.exec("ROLLBACK;");
        throw error;
      }
    }
    let removed = 0;
    for (const [id, review] of this.reviews) {
      if (review.expiresAt < cutoffIso && removed < limit) { this.reviews.delete(id); removed++; }
    }
    for (const [origin, id] of this.origins) if (!this.reviews.has(id)) this.origins.delete(origin);
    return removed;
  }

  private expireIfNeeded(review: PendingReview): void {
    if (review.status === "PENDING" && Date.now() >= Date.parse(review.expiresAt)) {
      review.status = "EXPIRED";
    }
  }

  private fromRow(row: StoredReviewRow): PendingReview {
    return {
      id: row.id,
      agentId: row.agent_id,
      evaluation: deserializeStoredValue<PolicyEvaluation>(row.evaluation_json),
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      resolvedAt: row.resolved_at ?? undefined,
      customerId: row.customer_id ?? undefined,
      transactionHash: row.transaction_hash ?? undefined,
      consumedAt: row.consumed_at ?? undefined,
      consumedBy: row.consumed_by ?? undefined,
      chain: row.chain ?? undefined,
      policyId: row.policy_id ?? undefined,
      policyFingerprint: row.policy_fingerprint ?? undefined
    };
  }
}
