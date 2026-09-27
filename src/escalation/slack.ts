import type { PendingReview } from "./pending-store.js";

/**
 * Posts a NEEDS_REVIEW decision to a Slack Incoming Webhook with the
 * decoded human-readable diff, plus a link to a self-hosted approve/deny
 * page (see review-routes.ts).
 *
 * Deliberately does NOT use Slack interactive Block Kit buttons -- those
 * require a full Slack App with an interactivity request URL and
 * signing-secret verification, which is real additional scope. A plain
 * link to our own approve/deny page gets the same human-in-the-loop
 * outcome without it.
 */
export async function escalateToSlack(review: PendingReview, webhookUrl: string, reviewUrl: string): Promise<void> {
  const lines = review.evaluation.decoded.instructions.map((instruction) => {
    const fields = JSON.stringify(instruction.fields, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    return `• \`${instruction.programId}\` :: *${instruction.instructionName}* (${instruction.mode})\n  ${fields}`;
  });

  const payload = {
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: "Transaction needs review", emoji: true }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Agent:* \`${review.agentId}\`\n*Fee payer:* \`${review.evaluation.decoded.feePayer}\`\n*Reasons:* ${review.evaluation.reasons.join("; ") || "none given"}`
        }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Decoded instructions:*\n${lines.join("\n")}` }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `<${reviewUrl}|Review and approve or deny>` }
      }
    ]
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Slack webhook responded ${response.status}: ${await response.text()}`);
  }
}
