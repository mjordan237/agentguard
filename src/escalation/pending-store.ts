import { randomUUID } from "node:crypto";
import type { PolicyEvaluation } from "../policy/types.js";

export type ReviewStatus = "PENDING" | "APPROVED" | "DENIED";

export interface PendingReview {
  id: string;
  agentId: string;
  evaluation: PolicyEvaluation;
  status: ReviewStatus;
  createdAt: string;
}

/**
 * In-memory store for transactions awaiting human review. A hackathon-
 * scale store -- fine for a single process demo, not for production
 * (no persistence, no expiry).
 */
export class PendingReviewStore {
  private readonly reviews = new Map<string, PendingReview>();

  create(agentId: string, evaluation: PolicyEvaluation): PendingReview {
    const review: PendingReview = {
      id: randomUUID(),
      agentId,
      evaluation,
      status: "PENDING",
      createdAt: new Date().toISOString()
    };
    this.reviews.set(review.id, review);
    return review;
  }

  get(id: string): PendingReview | undefined {
    return this.reviews.get(id);
  }

  resolve(id: string, status: "APPROVED" | "DENIED"): PendingReview | undefined {
    const review = this.reviews.get(id);
    if (!review) return undefined;
    if (review.status !== "PENDING") return review; // already resolved, don't flip it again
    review.status = status;
    return review;
  }
}
