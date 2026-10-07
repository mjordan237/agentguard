import express, { type Response } from "express";
import { z } from "zod";
import { PublicKey, type Connection } from "@solana/web3.js";
import { evaluatePolicy } from "../policy/evaluate.js";
import { parseAndDecodeTransaction, type LookupTableResolver } from "../agent-integration/parse-transaction.js";
import type { IdlRegistry } from "../agent-integration/idl-registry.js";
import type { Policy, PolicyEvaluation } from "../policy/types.js";
import { PendingReviewStore } from "../escalation/pending-store.js";
import { createReviewRouter } from "../escalation/review-routes.js";
import { escalateToSlack } from "../escalation/slack.js";
import { DailySpendTracker } from "../policy/daily-spend-tracker.js";
import { EvaluationLog, type EvaluationLogEntry } from "../observability/evaluation-log.js";
import { signThroughKora, type KoraGateConfig } from "../gateway/kora-gate.js";
import { evaluateSquadsUpgradeProposal, parseTransactionIndex, type FetchLike, type KnownSolanaCluster } from "../gateway/squads-upgrade-gate.js";
import { RateLimiter } from "./rate-limiter.js";

const evaluateRequestSchema = z.object({
  agentId: z.string(),
  policyId: z.string(),
  transactionBase64: z.string()
});

// squadsProgramId is deliberately NOT accepted here -- which Squads
// program's accounts are trusted is a server-side configuration
// decision (ServerConfig.squadsProgramId), not something a requester
// can redirect by passing an arbitrary program ID in the body.
const squadsUpgradeCheckRequestSchema = z.object({
  multisigPda: z.string(),
  transactionIndex: z.union([z.string(), z.number()])
});

export interface ServerConfig {
  baseUrl: string;
  slackWebhookUrl?: string;
  resolveLookupTable?: LookupTableResolver;
  /** When set, ALLOWed transactions from /gate-and-sign are actually submitted to Kora for signing. */
  koraGate?: KoraGateConfig;
  /** Required for POST /squads/upgrade-check -- reads the pending proposal directly from the chain. */
  connection?: Connection;
  /**
   * Which cluster `connection` actually talks to -- required for
   * /squads/upgrade-check to attribute verify.osec.io evidence
   * correctly. verify.osec.io's remote verification is mainnet-only;
   * any other value (including unset) means verification checks return
   * UNKNOWN rather than silently assuming mainnet.
   */
  solanaCluster?: KnownSolanaCluster;
  /** Server-side trust anchor for /squads/upgrade-check; defaults to the real Squads V4 program if unset. */
  squadsProgramId?: PublicKey;
  /** Test-only injection point for the verify.osec.io client; production always uses the real global fetch. */
  verificationFetch?: FetchLike;
  /** Per-IP rate limit for /evaluate and /gate-and-sign. Defaults to 30 requests per 60s window. */
  rateLimit?: { maxRequests: number; windowMs: number };
}

interface EvaluatedRequest {
  agentId: string;
  transactionBase64: string;
  evaluation: PolicyEvaluation;
  logEntry: EvaluationLogEntry;
}

interface EvaluationError {
  status: number;
  body: Record<string, unknown>;
}

export function createServer(policies: Map<string, Policy>, registry: IdlRegistry, config: ServerConfig) {
  const app = express();
  const reviewStore = new PendingReviewStore();
  const dailySpend = new DailySpendTracker();
  const evaluationLog = new EvaluationLog();
  const rateLimiter = new RateLimiter(config.rateLimit?.maxRequests ?? 30, config.rateLimit?.windowMs ?? 60_000);
  app.use(express.json());
  app.use(createReviewRouter(reviewStore));

  function rateLimited(req: express.Request, res: Response, next: express.NextFunction) {
    if (!rateLimiter.allow(req.ip ?? "unknown")) {
      return res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests. Try again shortly." });
    }
    next();
  }

  async function evaluateTransactionRequest(body: unknown): Promise<EvaluatedRequest | EvaluationError> {
    const parsed = evaluateRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { error: "INVALID_REQUEST", details: parsed.error.flatten() } };
    }
    const policy = policies.get(parsed.data.policyId);
    if (!policy) return { status: 404, body: { error: "POLICY_NOT_FOUND" } };

    let decoded;
    try {
      decoded = await parseAndDecodeTransaction(parsed.data.transactionBase64, registry, config.resolveLookupTable);
    } catch (error) {
      return { status: 400, body: { error: "TRANSACTION_PARSE_FAILED", message: (error as Error).message } };
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

    return { agentId: parsed.data.agentId, transactionBase64: parsed.data.transactionBase64, evaluation, logEntry };
  }

  function respondNeedsReview(res: Response, agentId: string, evaluation: PolicyEvaluation, logEntry: EvaluationLogEntry) {
    const review = reviewStore.create(agentId, evaluation);
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

  app.post("/evaluate", rateLimited, async (req, res) => {
    const result = await evaluateTransactionRequest(req.body);
    if ("status" in result) return res.status(result.status).json(result.body);
    const { agentId, evaluation, logEntry } = result;

    if (evaluation.decision === "NEEDS_REVIEW") {
      return respondNeedsReview(res, agentId, evaluation, logEntry);
    }

    return res.status(200).type("application/json").send(toJsonSafe({ ...evaluation, logEntryId: logEntry.id }));
  });

  app.post("/gate-and-sign", rateLimited, async (req, res) => {
    const result = await evaluateTransactionRequest(req.body);
    if ("status" in result) return res.status(result.status).json(result.body);
    const { agentId, transactionBase64, evaluation, logEntry } = result;

    if (evaluation.decision === "NEEDS_REVIEW") {
      return respondNeedsReview(res, agentId, evaluation, logEntry);
    }

    if (!config.koraGate) {
      return res.status(503).json({
        error: "KORA_NOT_CONFIGURED",
        message: "Policy ALLOWed this transaction, but no Kora client is configured to sign it."
      });
    }

    try {
      const signed = await signThroughKora(config.koraGate, transactionBase64);
      return res.status(200).type("application/json").send(toJsonSafe({ ...evaluation, logEntryId: logEntry.id, kora: signed }));
    } catch (error) {
      return res.status(502).json({ error: "KORA_SIGNING_FAILED", message: (error as Error).message });
    }
  });

  app.post("/squads/upgrade-check", async (req, res) => {
    const parsed = squadsUpgradeCheckRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    }
    if (!config.connection) {
      return res.status(503).json({ error: "CONNECTION_NOT_CONFIGURED", message: "No Solana RPC connection is configured to read the pending proposal." });
    }

    let multisigPda: PublicKey;
    try {
      multisigPda = new PublicKey(parsed.data.multisigPda);
    } catch (error) {
      return res.status(400).json({ error: "INVALID_PUBLIC_KEY", message: (error as Error).message });
    }

    const transactionIndex = parseTransactionIndex(parsed.data.transactionIndex);
    if (transactionIndex === undefined) {
      return res.status(400).json({
        error: "INVALID_TRANSACTION_INDEX",
        message: "transactionIndex must be a non-negative integer within u64 range, not a fraction, negative number, unsafe JS number, or malformed string."
      });
    }

    try {
      const evaluation = await evaluateSquadsUpgradeProposal(
        config.connection,
        multisigPda,
        transactionIndex,
        config.solanaCluster,
        config.squadsProgramId,
        config.verificationFetch
      );
      return res.status(200).type("application/json").send(toJsonSafe(evaluation));
    } catch (error) {
      return res.status(502).json({ error: "SQUADS_READ_FAILED", message: (error as Error).message });
    }
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
