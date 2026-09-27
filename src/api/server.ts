import express from "express";
import { z } from "zod";
import { evaluatePolicy } from "../policy/evaluate.js";
import { parseAndDecodeTransaction, type LookupTableResolver } from "../agent-integration/parse-transaction.js";
import type { IdlRegistry } from "../agent-integration/idl-registry.js";
import type { Policy } from "../policy/types.js";
import { PendingReviewStore } from "../escalation/pending-store.js";
import { createReviewRouter } from "../escalation/review-routes.js";
import { escalateToSlack } from "../escalation/slack.js";
import { DailySpendTracker } from "../policy/daily-spend-tracker.js";
import { EvaluationLog } from "../observability/evaluation-log.js";

const evaluateRequestSchema = z.object({
  agentId: z.string(),
  policyId: z.string(),
  transactionBase64: z.string()
});

export interface ServerConfig {
  baseUrl: string;
  slackWebhookUrl?: string;
  resolveLookupTable?: LookupTableResolver;
}

export function createServer(policies: Map<string, Policy>, registry: IdlRegistry, config: ServerConfig) {
  const app = express();
  const reviewStore = new PendingReviewStore();
  const dailySpend = new DailySpendTracker();
  const evaluationLog = new EvaluationLog();
  app.use(express.json());
  app.use(createReviewRouter(reviewStore));

  app.post("/evaluate", async (req, res) => {
    const parsed = evaluateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }
    const policy = policies.get(parsed.data.policyId);
    if (!policy) return res.status(404).json({ error: "POLICY_NOT_FOUND" });

    let decoded;
    try {
      decoded = await parseAndDecodeTransaction(parsed.data.transactionBase64, registry, config.resolveLookupTable);
    } catch (error) {
      return res.status(400).json({ error: "TRANSACTION_PARSE_FAILED", message: (error as Error).message });
    }

    const evaluation = evaluatePolicy(decoded, policy, dailySpend.spentToday(policy.policyId));
    const logEntry = evaluationLog.record(parsed.data.agentId, policy.policyId, evaluation);

    if (evaluation.decision === "ALLOW") {
      const amountsByAsset: Record<string, bigint> = {};
      for (const instruction of decoded.instructions) {
        if (instruction.amount === undefined) continue;
        const asset = instruction.asset ?? "native";
        amountsByAsset[asset] = (amountsByAsset[asset] ?? 0n) + instruction.amount;
      }
      dailySpend.record(policy.policyId, amountsByAsset);
    }

    if (evaluation.decision === "NEEDS_REVIEW") {
      const review = reviewStore.create(parsed.data.agentId, evaluation);
      const reviewUrl = `${config.baseUrl}/review/${review.id}`;

      if (config.slackWebhookUrl) {
        // Best-effort: a failed Slack post shouldn't hide a NEEDS_REVIEW
        // decision from the caller, and it must not crash the request.
        escalateToSlack(review, config.slackWebhookUrl, reviewUrl).catch((error) => {
          console.error(`Slack escalation failed for review ${review.id}:`, error);
        });
      }

      return res
        .status(200)
        .type("application/json")
        .send(toJsonSafe({ ...evaluation, reviewId: review.id, reviewUrl, logEntryId: logEntry.id }));
    }

    return res.status(200).type("application/json").send(toJsonSafe({ ...evaluation, logEntryId: logEntry.id }));
  });

  app.get("/transactions/:id", (req, res) => {
    const entry = evaluationLog.get(req.params.id);
    if (!entry) return res.status(404).json({ error: "LOG_ENTRY_NOT_FOUND" });
    return res.status(200).type("application/json").send(toJsonSafe(entry));
  });

  app.get("/agents/:agentId/history", (req, res) => {
    const decisionParam = req.query.decision;
    const decision = decisionParam === "ALLOW" || decisionParam === "NEEDS_REVIEW" ? decisionParam : undefined;
    const limitParam = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    const limit = Number.isFinite(limitParam) ? limitParam : undefined;

    const entries = evaluationLog.query({ agentId: req.params.agentId, decision, limit });
    const summary = evaluationLog.summaryByAgent(req.params.agentId);
    return res.status(200).type("application/json").send(toJsonSafe({ summary, entries }));
  });

  return app;
}

/**
 * solana-clear-sign deliberately keeps all decoded integers as bigint --
 * no division or IEEE-754 conversion for amounts -- so the default
 * JSON.stringify (which throws on bigint) can't serialize an evaluation
 * result directly. Stringify every bigint instead of silently rounding it.
 */
function toJsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val));
}
