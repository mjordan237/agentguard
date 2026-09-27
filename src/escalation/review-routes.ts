import { Router } from "express";
import type { PendingReviewStore } from "./pending-store.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function fieldsToText(fields: Record<string, unknown>): string {
  return JSON.stringify(fields, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
}

export function createReviewRouter(store: PendingReviewStore): Router {
  const router = Router();

  router.get("/review/:id", (req, res) => {
    const review = store.get(req.params.id);
    if (!review) return res.status(404).send("Review not found.");

    const instructionRows = review.evaluation.decoded.instructions
      .map(
        (instruction) =>
          `<li><code>${escapeHtml(instruction.programId)}</code> :: <strong>${escapeHtml(instruction.instructionName)}</strong> (${escapeHtml(instruction.mode)})<br><pre>${escapeHtml(fieldsToText(instruction.fields))}</pre></li>`
      )
      .join("\n");

    res.type("html").send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Review ${escapeHtml(review.id)}</title></head>
<body>
  <h1>Transaction review</h1>
  <p><strong>Status:</strong> ${escapeHtml(review.status)}</p>
  <p><strong>Agent:</strong> ${escapeHtml(review.agentId)}</p>
  <p><strong>Fee payer:</strong> ${escapeHtml(review.evaluation.decoded.feePayer)}</p>
  <p><strong>Reasons:</strong> ${escapeHtml(review.evaluation.reasons.join("; ") || "none given")}</p>
  <h2>Decoded instructions</h2>
  <ul>${instructionRows}</ul>
  ${
    review.status === "PENDING"
      ? `<form method="post" action="/review/${review.id}/approve" style="display:inline"><button type="submit">Approve</button></form>
         <form method="post" action="/review/${review.id}/deny" style="display:inline"><button type="submit">Deny</button></form>`
      : `<p>This review has already been ${escapeHtml(review.status.toLowerCase())}.</p>`
  }
</body>
</html>`);
  });

  router.post("/review/:id/approve", (req, res) => {
    const review = store.resolve(req.params.id, "APPROVED");
    if (!review) return res.status(404).send("Review not found.");
    res.redirect(`/review/${review.id}`);
  });

  router.post("/review/:id/deny", (req, res) => {
    const review = store.resolve(req.params.id, "DENIED");
    if (!review) return res.status(404).send("Review not found.");
    res.redirect(`/review/${review.id}`);
  });

  return router;
}
