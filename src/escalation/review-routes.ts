import { Router, urlencoded, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import type { PendingReviewStore } from "./pending-store.js";

export interface ReviewRouterOptions {
  /** Required for approval and denial. If absent, mutations are disabled. */
  actionSecret?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function fieldsToText(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

function actionSecretFromRequest(req: Request): string | undefined {
  const headerSecret = req.get("x-review-action-secret");
  if (headerSecret) return headerSecret;
  return typeof req.body?.secret === "string" ? req.body.secret : undefined;
}

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function createReviewRouter(store: PendingReviewStore, options: ReviewRouterOptions = {}): Router {
  const router = Router();
  router.use(urlencoded({ extended: false }));

  router.get("/review/:id", (req, res) => {
    const review = store.get(req.params.id);
    if (!review) return res.status(404).send("Review not found.");

    const instructionRows = review.evaluation.decoded.instructions
      .map(
        (instruction) =>
          `<li><code>${escapeHtml(instruction.programId)}</code> :: <strong>${escapeHtml(instruction.instructionName)}</strong> (${escapeHtml(instruction.mode)})<br><pre>${escapeHtml(fieldsToText(instruction.fields))}</pre></li>`
      )
      .join("\n");

    const actionsEnabled = Boolean(options.actionSecret);
    const pendingActions = review.status === "PENDING" && actionsEnabled
      ? `<form method="post" action="/review/${review.id}/approve" style="display:inline">
           <label>Approval secret <input type="password" name="secret" autocomplete="off" required></label>
           <button type="submit">Approve</button>
         </form>
         <form method="post" action="/review/${review.id}/deny" style="display:inline">
           <label>Approval secret <input type="password" name="secret" autocomplete="off" required></label>
           <button type="submit">Deny</button>
         </form>`
      : review.status === "PENDING"
        ? "<p>Review actions are disabled because REVIEW_ACTION_SECRET is not configured.</p>"
        : review.status === "EXPIRED"
          ? `<p>This review expired at ${escapeHtml(review.expiresAt)} and can no longer be acted on.</p>`
          : `<p>This review has already been ${escapeHtml(review.status.toLowerCase())} at ${escapeHtml(review.resolvedAt ?? "an unknown time")}.</p>`;

    res.type("html").send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Review ${escapeHtml(review.id)}</title></head>
<body>
  <h1>Transaction review</h1>
  <p><strong>Status:</strong> ${escapeHtml(review.status)}</p>
  <p><strong>Created:</strong> ${escapeHtml(review.createdAt)}</p>
  <p><strong>Expires:</strong> ${escapeHtml(review.expiresAt)}</p>
  <p><strong>Agent:</strong> ${escapeHtml(review.agentId)}</p>
  <p><strong>Fee payer:</strong> ${escapeHtml(review.evaluation.decoded.feePayer)}</p>
  <p><strong>Reasons:</strong> ${escapeHtml(review.evaluation.reasons.join("; ") || "none given")}</p>
  <h2>Decoded instructions</h2>
  <ul>${instructionRows}</ul>
  ${pendingActions}
</body>
</html>`);
  });

  function resolveReview(status: "APPROVED" | "DENIED") {
    return (req: Request, res: Response) => {
      if (!options.actionSecret) {
        return res.status(503).send("Review actions are disabled because REVIEW_ACTION_SECRET is not configured.");
      }
      if (!secretMatches(actionSecretFromRequest(req), options.actionSecret)) {
        return res.status(401).send("A valid review action secret is required.");
      }

      const review = store.resolve(req.params.id, status);
      if (!review) return res.status(404).send("Review not found.");
      if (review.status === "EXPIRED") return res.status(410).send("Review expired and can no longer be acted on.");
      res.redirect(`/review/${review.id}`);
    };
  }

  router.post("/review/:id/approve", resolveReview("APPROVED"));
  router.post("/review/:id/deny", resolveReview("DENIED"));
  return router;
}
