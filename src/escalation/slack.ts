import type { PendingReview } from "./pending-store.js";

/** Posts the policy reasons, decoded instructions and authenticated review-page link to a Slack incoming webhook. Decisions are made on the review page. */

/** agentId is an unrestricted client string; Slack renders &, <, > as markup, so an unescaped value could inject a fake link or an @channel ping. */
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
          text: `*Agent:* \`${escapeSlackMrkdwn(review.agentId)}\`\n*Fee payer:* \`${escapeSlackMrkdwn(review.evaluation.decoded.feePayer)}\`\n*Reasons:* ${escapeSlackMrkdwn(review.evaluation.reasons.join(" ") || "none given")}`
        }
      },
      ...(review.explanation
        ? [{
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*AI note (advisory only, ${escapeSlackMrkdwn(review.explanation.model)}):* ${review.explanation.truncated ? "(the model saw only part of the transaction) " : ""}${escapeSlackMrkdwn(review.explanation.summary)}${review.explanation.risks.map((risk) => `\n  - ${escapeSlackMrkdwn(risk)}`).join("")}`
            }
          }]
        : []),
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
