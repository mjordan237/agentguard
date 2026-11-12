import assert from "node:assert/strict";

/** What a signed-in reviewer is shown about a review (GET /operator/api/reviews/:id). */
export interface ReviewView {
  id: string;
  status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
  actionable: boolean;
  agentId: string;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: { kind: "reviewer"; name: string } | { kind: "shared-secret" } | null;
  steps: Array<{ step: string; label: string; text: string; badge?: string; code?: string }>;
  advisoryExplanation: { model: string; summary: string; risks: string[]; truncated: boolean } | null;
  instructions: Array<{ programId: string; instructionName: string; mode: string; fields: Record<string, unknown> }>;
}

/** Reads a review the way the review page does after sign-in: the credential in a header, never the URL. */
export async function readReview(baseUrl: string, id: string, credential: { token: string } | { secret: string }): Promise<ReviewView> {
  const headers: Record<string, string> = "token" in credential ? { "x-reviewer-token": credential.token } : { "x-review-action-secret": credential.secret };
  const response = await fetch(`${baseUrl}/operator/api/reviews/${id}`, { headers });
  assert.equal(response.status, 200, `reading review ${id}`);
  return (await response.json()) as ReviewView;
}

export const decisionOf = (view: ReviewView) => view.steps.find((step) => step.step === "decision")!.text;
