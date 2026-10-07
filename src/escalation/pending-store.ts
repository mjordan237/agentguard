import { randomUUID } from "node:crypto";
import type { PolicyEvaluation } from "../policy/types.js";

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
}

/**
 * In-memory store for transactions awaiting human review. A hackathon-
 * scale store -- fine for a single process demo, not for production
 * (no persistence and no per-reviewer identity record).
 */
export class PendingReviewStore {
  private readonly reviews = new Map<string, PendingReview>();
  private readonly expiresInMs: number;

  constructor(options: PendingReviewStoreOptions = {}) {
    this.expiresInMs = options.expiresInMs ?? 15 * 60_000;
    if (!Number.isFinite(this.expiresInMs) || this.expiresInMs <= 0) {
      throw new Error("Review expiry must be a positive finite number of milliseconds.");
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
    this.reviews.set(review.id, review);
    return review;
  }

  get(id: string): PendingReview | undefined {
    const review = this.reviews.get(id);
    if (!review) return undefined;
    this.expireIfNeeded(review);
    return review;
  }

  resolve(id: string, status: "APPROVED" | "DENIED"): PendingReview | undefined {
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
}
