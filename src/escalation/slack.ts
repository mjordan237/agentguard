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

/**
 * agentId is caller-controlled (an unrestricted string in the /evaluate
 * request body), and Slack's mrkdwn renders `&`, `<`, `>` as markup --
 * an unescaped agentId could inject a fake link or a `<!channel>` ping
 * into the alert. Escape every dynamic value the same way, on principle,
 * not just the ones that look risky today.
 */
function escapeSlackMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function escalateToSlack(review: PendingReview, webhookUrl: string, reviewUrl: string): Promise<void> {
  const lines = review.evaluation.decoded.instructions.map((instruction) => {
    const fields = JSON.stringify(instruction.fields, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    return `• \`${escapeSlackMrkdwn(instruction.programId)}\` :: *${escapeSlackMrkdwn(instruction.instructionName)}* (${escapeSlackMrkdwn(instruction.mode)})\n  ${escapeSlackMrkdwn(fields)}`;
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
          text: `*Agent:* \`${escapeSlackMrkdwn(review.agentId)}\`\n*Fee payer:* \`${escapeSlackMrkdwn(review.evaluation.decoded.feePayer)}\`\n*Reasons:* ${escapeSlackMrkdwn(review.evaluation.reasons.join("; ") || "none given")}`
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
