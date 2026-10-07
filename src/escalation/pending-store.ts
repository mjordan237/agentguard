import { randomUUID } from "node:crypto";
import type { PolicyEvaluation } from "../policy/types.js";
import { deserializeStoredValue, openSqliteDatabase, serializeStoredValue, type SqliteDatabase } from "../storage/sqlite.js";

export type ReviewStatus = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

export interface PendingReview {
  id: string;
  agentId: string;
  evaluation: PolicyEvaluation;
  status: ReviewStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
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
}

/**
 * In-memory store for transactions awaiting human review. A hackathon-
 * scale store -- fine for a single process demo, not for production
 * (no persistence and no per-reviewer identity record).
 */
export class PendingReviewStore {
  private readonly reviews = new Map<string, PendingReview>();
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
      `);
    }
  }

  create(agentId: string, evaluation: PolicyEvaluation): PendingReview {
    const createdAt = new Date();
    const review: PendingReview = {
      id: randomUUID(),
      agentId,
      evaluation,
      status: "PENDING",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.expiresInMs).toISOString()
    };
    if (this.database) {
      this.database.prepare(`
        INSERT INTO pending_reviews (id, agent_id, evaluation_json, status, created_at, expires_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        review.id,
        review.agentId,
        serializeStoredValue(review.evaluation),
        review.status,
        review.createdAt,
        review.expiresAt,
        null
      );
    } else {
      this.reviews.set(review.id, review);
    }
    return review;
  }

  get(id: string): PendingReview | undefined {
    if (this.database) {
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE pending_reviews SET status = 'EXPIRED'
        WHERE id = ? AND status = 'PENDING' AND expires_at <= ?
      `).run(id, now);
      const row = this.database.prepare(`
        SELECT id, agent_id, evaluation_json, status, created_at, expires_at, resolved_at
        FROM pending_reviews WHERE id = ?
      `).get(id) as StoredReviewRow | undefined;
      return row ? this.fromRow(row) : undefined;
    }
    const review = this.reviews.get(id);
    if (!review) return undefined;
    this.expireIfNeeded(review);
    return review;
  }

  resolve(id: string, status: "APPROVED" | "DENIED"): PendingReview | undefined {
    if (this.database) {
      const now = new Date().toISOString();
      this.database.prepare(`
        UPDATE pending_reviews SET status = 'EXPIRED'
        WHERE id = ? AND status = 'PENDING' AND expires_at <= ?
      `).run(id, now);
      this.database.prepare(`
        UPDATE pending_reviews SET status = ?, resolved_at = ?
        WHERE id = ? AND status = 'PENDING' AND expires_at > ?
      `).run(status, now, id, now);
      return this.get(id);
    }
    const review = this.get(id);
    if (!review) return undefined;
    if (review.status !== "PENDING") return review; // already resolved, don't flip it again
    review.status = status;
    review.resolvedAt = new Date().toISOString();
    return review;
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
      resolvedAt: row.resolved_at ?? undefined
    };
  }
}
