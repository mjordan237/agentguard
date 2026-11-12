import express, { type Response } from "express";
import { z } from "zod";
import { PublicKey, type Connection } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { evaluatePolicy } from "../policy/evaluate.js";
import { evaluateEvmSignable, evaluateEvmTransaction, EVM_GAS } from "../evm/evaluate.js";
import type { EvmSigner } from "../evm/sign.js";
import { evaluateEvmTypedData, decodeEvmTypedData } from "../evm/typed-data.js";
import { applyCodeCheck, codeCheckReasons, type CodeLookup } from "../evm/code-check.js";
import type { EvmBroadcaster } from "../evm/broadcast.js";
import { decodeEvmTransaction } from "../evm/decode.js";
import { parseAndDecodeTransaction, type LookupTableResolver } from "../agent-integration/parse-transaction.js";
import type { IdlRegistry } from "../agent-integration/idl-registry.js";
import type { Policy, PolicyEvaluation } from "../policy/types.js";
import { PendingReviewStore, type ConsumeOutcome, type PendingReview } from "../escalation/pending-store.js";
import { createReviewRouter } from "../escalation/review-routes.js";
import { RECENT_BLOCKHASH_WARNING, usesRecentBlockhash } from "../escalation/review-view.js";
import { ReviewerStore } from "../escalation/reviewer-store.js";
import { escalateToSlack } from "../escalation/slack.js";
import { DailySpendTracker, type SpendReservation } from "../policy/daily-spend-tracker.js";
import { policyFingerprint } from "../policy/fingerprint.js";
import { startRetention } from "../storage/retention.js";
import { EvaluationLog, type EvaluationLogEntry } from "../observability/evaluation-log.js";
import { AuditLog, type AuditEventType } from "../observability/audit-log.js";
import { isSimulationRejection, signThroughKora, KoraFeePayerInInstructionError, KoraFeePayerMismatchError, type KoraGateConfig } from "../gateway/kora-gate.js";
import { evaluateSquadsUpgradeProposal, parseTransactionIndex, type FetchLike, type KnownSolanaCluster } from "../gateway/squads-upgrade-gate.js";
import { CustomerStore, type Customer } from "../customers/customer-store.js";
import { transactionMessageHash } from "../gateway/message-hash.js";
import { checkSwapsBySimulation, type SwapSimulator } from "../gateway/swap-simulation.js";
import type { TurnkeyApi } from "../turnkey/api.js";
import { TurnkeyApprover, type GuardedWallet, type TurnkeyRetryPolicy } from "../turnkey/approver.js";
import { TurnkeyLifecycleStore } from "../turnkey/lifecycle-store.js";
import { clientKey, RateLimiter } from "./rate-limiter.js";
import { explainEvaluation, type ExplainerConfig } from "../analysis/nemotron-explainer.js";

const HISTORY_DEFAULT_LIMIT = 100;
/** Added to the reasons when an auto-ALLOW is routed to review because a concurrent reservation took the remaining daily budget. */
const DAILY_LIMIT_RACE_REASON = "The transaction would exceed the policy's daily limit once concurrent spending is counted, so it needs review.";
const HISTORY_MAX_LIMIT = 1000;

class SigningAuthorizationError extends Error {
  constructor(readonly status: 403 | 409, readonly code: string) {
    super(status === 403 ? "The customer is no longer authorized. Submit a new request with an active customer." : "The policy changed during this request. Submit a new request under the current policy.");
  }
}

const evaluateRequestSchema = z.object({
  agentId: z.string(),
  policyId: z.string(),
  transactionBase64: z.string(),
  /** /gate-and-sign only: an APPROVED review of this exact transaction, to sign it despite NEEDS_REVIEW. */
  reviewId: z.string().optional(),
  /**
   * /evaluate only: charge an ALLOWed transaction against the daily budget. Without it /evaluate is a
   * pure preview and spends nothing. Set it when you sign somewhere other than /gate-and-sign.
   */
  reserve: z.boolean().optional()
});

/** Decimal string that fits the given number of bits. Nothing larger can exist on chain, so nothing larger is accepted. */
const uintBits = (bits: bigint) => z.string().regex(/^\d{1,78}$/).refine((v) => /^\d+$/.test(v) && BigInt(v) < 1n << bits, `must be below 2^${bits}`);
const uint256String = uintBits(256n);
const uint64String = uintBits(64n);
const evmChainId = z.number().int().positive().safe();

/** EVM transaction as JSON. Amounts are decimal strings so nothing passes through a lossy JS number. */
const evmRequestSchema = z.object({
  agentId: z.string(),
  policyId: z.string(),
  /** Charge an ALLOWed transaction against the daily budget; without it the call is a pure preview. */
  reserve: z.boolean().optional(),
  transaction: z.object({
    chainId: evmChainId,
    from: z.string(),
    to: z.string().optional(),
    value: uint256String.optional(),
    data: z.string().optional()
  }).strict()
});

/** A fully specified EIP-1559 transaction to be gated and signed. Every number is a decimal string. */
const evmSignRequestSchema = z.object({
  agentId: z.string(),
  policyId: z.string(),
  /** An APPROVED review of this exact transaction, to sign it despite NEEDS_REVIEW. */
  reviewId: z.string().optional(),
  /** The server sends the transaction itself (after a fresh code check) and returns the hash, not the signed bytes. */
  broadcast: z.boolean().optional(),
  transaction: z.object({
    chainId: evmChainId,
    from: z.string(),
    to: z.string().optional(),
    value: uint256String.optional(),
    data: z.string().optional(),
    nonce: uint64String,
    gasLimit: uint64String,
    maxFeePerGas: uint256String,
    maxPriorityFeePerGas: uint256String
  }).strict()
});

/** EIP-712 signature request (permits). Evaluated, never signed: no route signs typed data. */
const evmTypedRequestSchema = z.object({
  agentId: z.string(),
  policyId: z.string(),
  reserve: z.boolean().optional(),
  from: z.string(),
  typedData: z.object({
    domain: z.record(z.string(), z.unknown()),
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
    primaryType: z.string(),
    message: z.record(z.string(), z.unknown())
  }).strict()
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
  /** When set, ALLOWed transactions from /gate-and-sign are validated against Kora's real fee payer, then signed and submitted through it. */
  koraGate?: KoraGateConfig;
  /**
   * When set, a transaction with a swap that policy would ALLOW is simulated first, and goes to review if the
   * signer's balances change in any way the swap does not explain (see swap-simulation.ts).
   */
  swapSimulator?: SwapSimulator;
  /**
   * Turnkey wallets AgentGuard must approve before Turnkey signs (see src/turnkey/approver.ts). Keyed by the
   * wallet's Solana address. `autoStart: false` leaves polling off, for tests.
   */
  turnkey?: {
    api: TurnkeyApi; wallets: Record<string, GuardedWallet>; pollMs?: number; autoStart?: boolean;
    /** Defaults to a store at persistencePath. */ lifecycle?: TurnkeyLifecycleStore;
    /** Backoff and vote-retry bounds; see TurnkeyRetryPolicy. `now` and `random` are for tests. */
    retry?: Partial<TurnkeyRetryPolicy>; now?: () => number; random?: () => number;
  };
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
  /** Test-only injection point. Defaults to an append-only audit log in the same database as everything else. */
  auditLog?: AuditLog;
  /**
   * Number of reverse-proxy hops in front of the server (see trust-proxy.ts). Unset: the client address is the
   * socket's own, and X-Forwarded-For is ignored.
   */
  trustProxy?: number;
  /** Per-IP rate limit for each endpoint family. Defaults to 30 requests per 60s window. */
  rateLimit?: { maxRequests: number; windowMs: number };
  /** Secret required for review approval or denial. Omit to disable review mutations fail closed. */
  reviewActionSecret?: string;
  /** Named reviewers. Defaults to a store backed by persistencePath (or memory when that is unset). */
  reviewers?: ReviewerStore;
  /** When true, only reviewer tokens can approve or deny; the shared secret is ignored. */
  requireReviewers?: boolean;
  /** How long a PENDING review can be acted on. Defaults to 15 minutes. */
  reviewExpiryMs?: number;
  /** SQLite path for durable reviews, evaluation history, and daily spend. Omit for in-memory stores in tests. */
  persistencePath?: string;
  /** Customer accounts. Defaults to a store backed by persistencePath. Once any customer exists, /evaluate and the other transaction endpoints require that customer's API key. */
  customers?: CustomerStore;
  /** When true, the transaction endpoints require an API key even before the first customer exists (they then reject everything). */
  requireApiKeys?: boolean;
  /** Entries older than this are deleted hourly (reviews by expiry time, history by record time). Omit to keep everything. Must exceed reviewExpiryMs. */
  retentionMs?: number;
  /** Signs EVM transactions that /gate-and-sign-evm has allowed or a person has approved. Without it that endpoint answers 503. */
  evmSigner?: EvmSigner;
  /** Reads the code behind EVM destinations (see rpcCodeLookup). When set, delegated (EIP-7702) accounts, unlisted contracts and unreadable accounts go to review. Without it that check is off. */
  evmCodeLookup?: CodeLookup;
  /** Sends signed EVM transactions. Needed for `broadcast: true` on /gate-and-sign-evm, where the server keeps the signed bytes and sends them itself after a fresh code check. */
  evmBroadcaster?: EvmBroadcaster;
  /** When set, escalated reviews get an advisory Nemotron-written note. It never affects the decision. */
  explainer?: ExplainerConfig;
}

interface EvaluatedRequest {
  /** Daily budget reserved for an ALLOW; /gate-and-sign gives it back if signing does not happen. */
  reserved?: SpendReservation;
  agentId: string;
  reviewId?: string;
  transactionBase64: string;
  evaluation: PolicyEvaluation;
  logEntry: EvaluationLogEntry;
  /** The policy as evaluated; its fingerprint binds any review opened for this request. */
  policy: Policy;
}

interface EvaluationError {
  status: number;
  body: Record<string, unknown>;
}

/** JSON with object keys sorted at every level, so the same typed data always hashes the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function createServer(policies: Map<string, Policy>, registry: IdlRegistry, config: ServerConfig) {
  const app = express();
  const reviewStore = new PendingReviewStore({ expiresInMs: config.reviewExpiryMs, persistencePath: config.persistencePath });
  const reviewers = config.reviewers ?? new ReviewerStore({ persistencePath: config.persistencePath });
  const customers = config.customers ?? new CustomerStore({ persistencePath: config.persistencePath });
  const dailySpend = new DailySpendTracker({ persistencePath: config.persistencePath });
  const evaluationLog = new EvaluationLog({ persistencePath: config.persistencePath });
  const auditLog = config.auditLog ?? new AuditLog({ persistencePath: config.persistencePath });
  const turnkeyLifecycle = config.turnkey ? (config.turnkey.lifecycle ?? new TurnkeyLifecycleStore({ persistencePath: config.persistencePath })) : undefined;
  // Events recorded BEFORE an action fail the request if they cannot be written: nothing is allowed to happen
  // without a record. Events recorded AFTER a signature exists cannot undo it, so a write failure there is
  // reported loudly with the whole event instead of hiding a signature that may be on chain.
  const audit = (customerId: string | undefined, type: AuditEventType, data: Record<string, unknown>) => { auditLog.append(customerId, type, data); };
  const auditAfterSigning = (customerId: string | undefined, type: AuditEventType, data: Record<string, unknown>) => {
    try { auditLog.append(customerId, type, data); }
    catch (error) { console.error("AUDIT WRITE FAILED after signing; event follows so it can be recovered:", JSON.stringify({ customerId, type, data }), error); }
  };
  const recordEvaluation = (agentId: string, policyId: string, evaluation: PolicyEvaluation, customerId: string | undefined, endpoint: string): EvaluationLogEntry => {
    const entry = evaluationLog.record(agentId, policyId, evaluation, customerId);
    audit(customerId, "evaluated", { logEntryId: entry.id, agentId, policyId, endpoint, decision: evaluation.decision, reasons: evaluation.reasons });
    return entry;
  };
  const rateLimiter = new RateLimiter(
    config.rateLimit?.maxRequests ?? 30,
    config.rateLimit?.windowMs ?? 60_000,
    { persistencePath: config.persistencePath }
  );
  if (config.retentionMs !== undefined) {
    if (!Number.isFinite(config.retentionMs) || config.retentionMs <= (config.reviewExpiryMs ?? 15 * 60_000)) {
      throw new Error("retentionMs must be a finite number greater than the review expiry.");
    }
    startRetention([evaluationLog, reviewStore, dailySpend, ...(turnkeyLifecycle ? [turnkeyLifecycle] : [])], config.retentionMs);
  }
  if (config.trustProxy !== undefined) app.set("trust proxy", config.trustProxy);
  else {
    let warned = false;
    app.use((req, _res, next) => {
      if (!warned && req.get("x-forwarded-for") !== undefined) {
        warned = true;
        console.warn("A request carried X-Forwarded-For but TRUST_PROXY is not set, so every client shares the proxy's rate-limit budget. Set TRUST_PROXY to the number of proxy hops.");
      }
      next();
    });
  }
  app.use(express.json());

  // Express 4 does not catch rejected promises from async handlers; without this an unexpected error
  // leaves the request hanging. Fail closed with a generic 500 and keep the details in the server log.
  const safe = (handler: (req: express.Request, res: Response) => Promise<unknown>) =>
    (req: express.Request, res: Response, next: express.NextFunction) => { handler(req, res).catch(next); };

  app.get("/healthz", (_req, res) => {
    const turnkey = (app.locals.turnkeyApprover as TurnkeyApprover | undefined)?.status();
    return res.status(200).json({ status: "ok", ...(turnkey ? { turnkey } : {}) });
  });

  function rateLimited(scope: string) {
    return (req: express.Request, res: Response, next: express.NextFunction) => {
      if (!rateLimiter.allow(`${scope}:${clientKey(req.ip)}`)) {
        return res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests. Try again shortly." });
      }
      next();
    };
  }

  const openModeLimited = rateLimited("transaction");

  /**
   * Open mode (no customers ever created, API keys not required): the per-IP limit applies and every
   * caller sees the server's built-in policies -- local demo behavior. Otherwise a valid API key
   * is required, the customer's own rate limit applies, and the request is scoped to that customer.
   * "Any customer ever created" (revoked included) keeps this from reopening if the last customer is revoked.
   */
  const transactionRateLimited = (req: express.Request, res: Response, next: express.NextFunction) => {
    if (!config.requireApiKeys && !customers.hasAnyCustomers()) return openModeLimited(req, res, next);
    const header = req.get("authorization");
    const key = header?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? req.get("x-api-key") ?? undefined;
    const customer = customers.authenticate(key);
    if (!customer) {
      // Bad-key attempts spend a per-IP budget that valid traffic never touches.
      if (!rateLimiter.allow(`auth-failure:${clientKey(req.ip)}`)) {
        return res.status(429).json({ error: "RATE_LIMITED", message: "Too many requests. Try again shortly." });
      }
      return res.status(401).json({ error: "INVALID_API_KEY", message: "A valid API key is required (Authorization: Bearer agk_...)." });
    }
    if (!rateLimiter.allow(`customer:${customer.id}`, customer.rateLimitPerMinute)) {
      return res.status(429).json({ error: "RATE_LIMITED", message: "Customer rate limit reached. Try again shortly." });
    }
    res.locals.customer = customer;
    next();
  };
  const customerOf = (res: Response): Customer | undefined => res.locals.customer as Customer | undefined;
  // Authentication at request entry cannot authorize a later signature after an awaited lookup or simulation.
  const authorizeSigning = (customer: Customer | undefined, policy: Policy) => {
    if (customer ? !customers.getActive(customer.id) : config.requireApiKeys || customers.hasAnyCustomers()) {
      throw new SigningAuthorizationError(403, "CUSTOMER_UNAUTHORIZED");
    }
    const current = customer ? [customers.getPolicy(customer.id, policy.policyId)].filter((entry): entry is Policy => entry !== undefined)
      : [...policies.values()].filter((entry) => entry.policyId === policy.policyId);
    if (current.length === 0 || !current.every((entry) => policyFingerprint(entry) === policyFingerprint(policy))) {
      throw new SigningAuthorizationError(409, "POLICY_CHANGED");
    }
  };
  const reviewActionRateLimited = rateLimited("review-action");

  // Review actions use an independent key namespace on the same limiter so
  // general endpoint traffic cannot consume the approval-secret guess budget.
  app.post("/review/:id/approve", reviewActionRateLimited);
  app.post("/review/:id/deny", reviewActionRateLimited);
  // The queue API checks a reviewer credential, so its guesses spend their own budget too.
  app.get("/operator/api/reviews", rateLimited("review-queue"));
  app.get("/operator/api/reviews/:id", rateLimited("review-queue"));
  /** The rules a review was judged under as they stand now, looked up by the policy id the review recorded. */
  const currentPolicy = (review: PendingReview): Policy | undefined => {
    if (!review.policyId) return undefined;
    if (review.customerId) return customers.getPolicy(review.customerId, review.policyId);
    const matches = [...policies.values()].filter((policy) => policy.policyId === review.policyId);
    // Two server policies sharing an id but not rules: cannot tell which one the review meant.
    return matches.length > 0 && matches.every((policy) => policyFingerprint(policy) === policyFingerprint(matches[0]!)) ? matches[0] : undefined;
  };
  app.use(createReviewRouter(reviewStore, {
    actionSecret: config.reviewActionSecret,
    reviewers,
    requireReviewers: config.requireReviewers,
    context: {
      activitiesFor: (reviewIds) => turnkeyLifecycle?.byReviewIds(reviewIds) ?? new Map(),
      auditFor: (review) => auditLog.forReview?.(review.customerId, review.id) ?? {},
      currentPolicyFingerprint: (review) => { const policy = currentPolicy(review); return policy ? policyFingerprint(policy) : undefined; }
    },
    onResolved: (review) => {
      audit(review.customerId, "review_resolved", {
        reviewId: review.id, status: review.status, transactionHash: review.transactionHash,
        by: review.resolvedBy?.kind === "reviewer" ? review.resolvedBy.name : "shared secret"
      });
      // A review a Turnkey request is waiting on: act on the decision now rather than at the next poll.
      void (app.locals.turnkeyApprover as TurnkeyApprover | undefined)?.poll();
    }
  }));

  /** Charges a transaction's spend. `reservationId` names the charge, so charging the same id again charges nothing more. */
  /** The amounts a reservation would charge, per asset: the evaluation's spend (what the limits were checked against) plus any extra. */
  function spendAmounts(evaluation: PolicyEvaluation, extra: Record<string, bigint> = {}): Record<string, bigint> {
    const amountsByAsset: Record<string, bigint> = { ...extra };
    if (evaluation.spend) {
      for (const [asset, amount] of Object.entries(evaluation.spend)) amountsByAsset[asset] = (amountsByAsset[asset] ?? 0n) + amount;
    } else {
      for (const instruction of evaluation.decoded.instructions) {
        if (instruction.amount === undefined) continue;
        const asset = instruction.asset ?? "native";
        amountsByAsset[asset] = (amountsByAsset[asset] ?? 0n) + instruction.amount;
      }
    }
    return amountsByAsset;
  }

  /** Charges a transaction's spend unconditionally (used when a human approval has overridden the daily limit for this exact transaction). */
  function recordSpend(policyId: string, evaluation: PolicyEvaluation, extra: Record<string, bigint> = {}, reservationId?: string): SpendReservation {
    return dailySpend.record(policyId, spendAmounts(evaluation, extra), reservationId);
  }

  /** A policy's per-asset daily limits as bigint. Assets absent here have no daily cap, as in evaluatePolicy. */
  const dailyLimitsOf = (policy: Policy): Record<string, bigint> => {
    const limits: Record<string, bigint> = {};
    for (const [asset, value] of Object.entries(policy.maxAmountPerDay ?? {})) limits[asset] = BigInt(value as string);
    return limits;
  };

  /**
   * Reserves an automatically ALLOWed transaction's spend, re-validating the daily limit atomically with the
   * reservation. Returns null when a concurrent reservation has since consumed the remaining budget, so the limit
   * read at evaluation time (before an awaited simulation or code check) is stale. null routes to human review,
   * which is the documented behaviour when the daily limit is exceeded; a human approval still overrides it.
   */
  const reserveAutoAllow = (policy: Policy, evaluation: PolicyEvaluation, extra: Record<string, bigint> = {}, reservationId?: string): SpendReservation | null =>
    dailySpend.reserveWithinLimit(policy.policyId, spendAmounts(evaluation, extra), dailyLimitsOf(policy), reservationId);

  async function evaluateTransactionRequest(body: unknown, customer: Customer | undefined, reserveSpend: (requested: boolean) => boolean, reservationId?: string): Promise<EvaluatedRequest | EvaluationError> {
    const parsed = evaluateRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { status: 400, body: { error: "INVALID_REQUEST", details: parsed.error.flatten() } };
    }
    // A customer can only reach policies it owns; anyone else's id looks exactly like a missing one.
    const policy = customer ? customers.getPolicy(customer.id, parsed.data.policyId) : policies.get(parsed.data.policyId);
    if (!policy) return { status: 404, body: { error: "POLICY_NOT_FOUND" } };

    let decoded;
    try {
      decoded = await parseAndDecodeTransaction(parsed.data.transactionBase64, registry, config.resolveLookupTable);
    } catch (error) {
      return { status: 400, body: { error: "TRANSACTION_PARSE_FAILED", message: (error as Error).message } };
    }

    let evaluation = evaluatePolicy(decoded, policy, dailySpend.spentToday(policy.policyId));
    // Only swaps that would be allowed are simulated: anything going to review is seen by a person anyway.
    if (config.swapSimulator && evaluation.decision === "ALLOW" && decoded.instructions.some((instruction) => instruction.swap)) {
      const check = await checkSwapsBySimulation(parsed.data.transactionBase64, decoded, config.swapSimulator);
      evaluation = check.reasons.length > 0
        ? { ...evaluation, decision: "NEEDS_REVIEW", reasons: check.reasons, simulation: { netChange: check.netChange } }
        : { ...evaluation, simulation: { netChange: check.netChange } };
    }
    // Turnkey uses an explicit wallet assignment and reauthorizes at its own submission boundary.
    if (reservationId === undefined) authorizeSigning(customer, policy);
    let reserved: SpendReservation | undefined;
    if (evaluation.decision === "ALLOW" && reserveSpend(parsed.data.reserve === true)) {
      const attempt = reserveAutoAllow(policy, evaluation, {}, reservationId);
      // null: a concurrent reservation consumed the remaining daily budget after the limit was read. Route to review.
      if (attempt === null) evaluation = { ...evaluation, decision: "NEEDS_REVIEW", reasons: evaluation.reasons.concat(DAILY_LIMIT_RACE_REASON) };
      else reserved = attempt;
    }
    // Recorded after the reservation decision, so the persisted history, the response and any review agree on the decision.
    const logEntry = recordEvaluation(parsed.data.agentId, policy.policyId, evaluation, customer?.id, "solana");

    return { reserved, agentId: parsed.data.agentId, reviewId: parsed.data.reviewId, transactionBase64: parsed.data.transactionBase64, evaluation, logEntry, policy };
  }

  function respondNeedsReview(res: Response, chain: string, agentId: string, policy: Policy, evaluation: PolicyEvaluation, logEntry: EvaluationLogEntry, customer?: Customer, transactionBase64?: string, messageHash?: string) {
    const { review, reviewUrl, expiryWarning } = openReview(chain, agentId, policy, evaluation, logEntry, customer, transactionBase64, messageHash);
    return res
      .status(200)
      .type("application/json")
      .send(toJsonSafe({ ...evaluation, reviewId: review.id, reviewUrl, logEntryId: logEntry.id, policyFingerprint: review.policyFingerprint, ...expiryWarning }));
  }

  /** The answer when an approval cannot be spent. Same codes on every path: REVIEW_<OUTCOME>. */
  function refuseApproval(res: Response, customerId: string | undefined, reviewId: string, outcome: Exclude<ConsumeOutcome, "ok">, context: Record<string, unknown>) {
    audit(customerId, "approval_refused", { reviewId, reason: outcome, ...context });
    const status = outcome === "not_found" ? 404 : outcome === "mismatch" ? 400 : 409;
    const message = outcome === "policy_changed"
      ? "The policy's rules have changed since this transaction was reviewed, so the approval no longer applies. Submit it again without reviewId for a new review."
      : `The review cannot be used to sign this transaction (${outcome.replace("_", " ")}).`;
    return res.status(status).json({ error: `REVIEW_${outcome.toUpperCase()}`, message });
  }

  /**
   * Opens a review, posts it to Slack and starts the AI note. Shared by the HTTP endpoints and the Turnkey approver.
   * With `originKey`, a review already opened for that key is returned as it is, without notifying anyone again.
   * `chain` is what the endpoint handled: "solana", or "evm:<chain id>" ("evm" when the request named none).
   */
  function openReview(chain: string, agentId: string, policy: Policy, evaluation: PolicyEvaluation, logEntry: EvaluationLogEntry, customer?: Customer, transactionBase64?: string, messageHash?: string, originKey?: string) {
    const transactionHash = messageHash ?? (transactionBase64 ? transactionMessageHash(transactionBase64) : undefined);
    const opened = originKey
      ? reviewStore.createForOrigin(originKey, agentId, evaluation, customer?.id, transactionHash, policy.policyId, policyFingerprint(policy), chain)
      : { review: reviewStore.create(agentId, evaluation, customer?.id, transactionHash, policy.policyId, policyFingerprint(policy), chain), created: true };
    const review = opened.review;
    const reviewUrl = `${config.baseUrl}/review/${review.id}`;
    if (!opened.created) return { review, reviewUrl, expiryWarning: {} };
    audit(customer?.id, "review_opened", { reviewId: review.id, logEntryId: logEntry.id, agentId, transactionHash: review.transactionHash, policyId: review.policyId, policyFingerprint: review.policyFingerprint });

    // The response below never waits on the model. The note is attached to the
    // review whenever it arrives (or never), and Slack is posted after that
    // attempt settles so the message can include it.
    const explained: Promise<void> = config.explainer
      ? explainEvaluation(evaluation, config.explainer)
          .then((explanation) => {
            if (explanation) {
              reviewStore.attachExplanation(review.id, explanation);
              review.explanation = explanation;
            }
          })
          .catch(() => undefined)
      : Promise.resolve();

    // A customer with its own webhook is escalated there; otherwise to the server-wide one.
    const webhookUrl = customer?.slackWebhookUrl ?? config.slackWebhookUrl;
    if (webhookUrl) {
      // Best-effort: a failed Slack post shouldn't hide a NEEDS_REVIEW
      // decision from the caller, and it must not crash the request.
      explained
        .then(() => escalateToSlack(review, webhookUrl, reviewUrl))
        .catch((error) => {
          console.error(`Slack escalation failed for review ${review.id}:`, error);
        });
    }

    // A Solana transaction built on a recent blockhash expires within about a minute, long before most reviews end,
    // and an approval only covers these exact bytes. Say so now, not after a person has spent time approving it.
    const expiryWarning = transactionBase64 && usesRecentBlockhash(evaluation) ? { warnings: [RECENT_BLOCKHASH_WARNING] } : {};

    return { review, reviewUrl, expiryWarning };
  }

  app.post("/evaluate", transactionRateLimited, safe(async (req, res) => {
    const result = await evaluateTransactionRequest(req.body, customerOf(res), (requested) => requested);
    if ("status" in result) return res.status(result.status).json(result.body);
    const { agentId, transactionBase64, evaluation, logEntry, policy } = result;

    if (evaluation.decision === "NEEDS_REVIEW") {
      return respondNeedsReview(res, "solana", agentId, policy, evaluation, logEntry, customerOf(res), transactionBase64);
    }

    return res.status(200).type("application/json").send(toJsonSafe({ ...evaluation, logEntryId: logEntry.id }));
  }));

  /** Shared tail of the EVM endpoints: log, queue a review if needed, otherwise optionally reserve daily budget. */
  function respondEvm(res: Response, chainId: number | undefined, customer: Customer | undefined, agentId: string, policy: Policy, evaluation: PolicyEvaluation, canonical: string, reserve: boolean) {
    authorizeSigning(customer, policy);
    const chain = chainId === undefined ? "evm" : `evm:${chainId}`;
    const messageHash = createHash("sha256").update(canonical).digest("hex");
    // Decide the final evaluation first (an auto-ALLOW that cannot reserve within the daily limit becomes a review),
    // then record it once, so the persisted history matches the response and the review.
    let finalEvaluation = evaluation;
    if (finalEvaluation.decision === "ALLOW" && reserve && reserveAutoAllow(policy, finalEvaluation) === null) {
      finalEvaluation = { ...finalEvaluation, decision: "NEEDS_REVIEW", reasons: finalEvaluation.reasons.concat(DAILY_LIMIT_RACE_REASON) };
    }
    const logEntry = recordEvaluation(agentId, policy.policyId, finalEvaluation, customer?.id, "evm");
    if (finalEvaluation.decision === "NEEDS_REVIEW") {
      return respondNeedsReview(res, chain, agentId, policy, finalEvaluation, logEntry, customer, undefined, messageHash);
    }
    return res.status(200).type("application/json").send(toJsonSafe({ ...finalEvaluation, logEntryId: logEntry.id }));
  }

  // Evaluate only: this route never signs (signing is /gate-and-sign-evm). The review is bound to a hash of the
  // canonical transaction fields, so an approval can later be checked against the exact call.
  app.post("/evaluate-evm", transactionRateLimited, safe(async (req, res) => {
    const parsed = evmRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const customer = customerOf(res);
    const policy = customer ? customers.getPolicy(customer.id, parsed.data.policyId) : policies.get(parsed.data.policyId);
    if (!policy) return res.status(404).json({ error: "POLICY_NOT_FOUND" });

    const t = parsed.data.transaction;
    const evmTx = { chainId: t.chainId, from: t.from, to: t.to, value: t.value === undefined ? undefined : BigInt(t.value), data: t.data };
    const evaluation = await applyCodeCheck(evaluateEvmTransaction(evmTx, policy, dailySpend.spentToday(policy.policyId)), decodeEvmTransaction(evmTx), policy, t.chainId, config.evmCodeLookup);
    const canonical = JSON.stringify([t.chainId, t.from.toLowerCase(), t.to?.toLowerCase() ?? null, t.value ?? "0", (t.data ?? "0x").toLowerCase()]);
    return respondEvm(res, t.chainId, customer, parsed.data.agentId, policy, evaluation, canonical, parsed.data.reserve === true);
  }));

  // Permit-style signatures can let a spender pull funds later with no transaction from the agent, so the
  // gate evaluates the signature request itself. Reviews are bound to a hash of the canonical typed data.
  app.post("/evaluate-evm-typed", transactionRateLimited, safe(async (req, res) => {
    const parsed = evmTypedRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const customer = customerOf(res);
    const policy = customer ? customers.getPolicy(customer.id, parsed.data.policyId) : policies.get(parsed.data.policyId);
    if (!policy) return res.status(404).json({ error: "POLICY_NOT_FOUND" });
    const request = { from: parsed.data.from, typedData: parsed.data.typedData };
    const rawChain = request.typedData.domain.chainId;
    const typedChain = typeof rawChain === "number" ? rawChain : typeof rawChain === "string" && /^\d+$/.test(rawChain) ? Number(rawChain) : undefined;
    const evaluation = await applyCodeCheck(evaluateEvmTypedData(request, policy, dailySpend.spentToday(policy.policyId)), decodeEvmTypedData(request), policy, typedChain, config.evmCodeLookup);
    return respondEvm(res, typedChain, customer, parsed.data.agentId, policy, evaluation, JSON.stringify([parsed.data.from.toLowerCase(), canonicalJson(parsed.data.typedData)]), parsed.data.reserve === true);
  }));

  // Gate, then sign an EVM transaction. The signed bytes are returned, not broadcast: the caller sends them.
  // Daily budget is reserved when the signature is made (a signed transaction can be broadcast later).
  app.post("/gate-and-sign-evm", transactionRateLimited, safe(async (req, res) => {
    const parsed = evmSignRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
    const signer = config.evmSigner;
    if (!signer) return res.status(503).json({ error: "EVM_SIGNER_NOT_CONFIGURED", message: "No EVM signer is configured on this server." });
    if (parsed.data.broadcast && !config.evmBroadcaster) return res.status(503).json({ error: "EVM_BROADCASTER_NOT_CONFIGURED", message: "This server cannot broadcast transactions." });
    const customer = customerOf(res);
    const policy = customer ? customers.getPolicy(customer.id, parsed.data.policyId) : policies.get(parsed.data.policyId);
    if (!policy) return res.status(404).json({ error: "POLICY_NOT_FOUND" });
    const t = parsed.data.transaction;
    if (t.from.toLowerCase() !== signer.address.toLowerCase()) {
      return res.status(400).json({ error: "SIGNER_MISMATCH", message: `This server signs for ${signer.address}, not ${t.from}.` });
    }

    const tx = {
      chainId: t.chainId, from: t.from, to: t.to, value: t.value === undefined ? undefined : BigInt(t.value), data: t.data,
      nonce: BigInt(t.nonce), gasLimit: BigInt(t.gasLimit), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas)
    };
    const evaluation0 = await applyCodeCheck(evaluateEvmSignable(tx, policy, dailySpend.spentToday(policy.policyId)), decodeEvmTransaction(tx), policy, tx.chainId, config.evmCodeLookup);
    authorizeSigning(customer, policy);
    // The review is bound to every field that is signed, gas included, so an approval cannot be reused for a different transaction.
    const canonical = JSON.stringify([t.chainId, t.from.toLowerCase(), t.to?.toLowerCase() ?? null, t.value ?? "0", (t.data ?? "0x").toLowerCase(), t.nonce, t.gasLimit, t.maxFeePerGas, t.maxPriorityFeePerGas]);
    const messageHash = createHash("sha256").update(canonical).digest("hex");
    const gasCost = { [EVM_GAS]: tx.gasLimit * tx.maxFeePerGas };

    // Decide the final evaluation before recording it. An auto-ALLOW is reserved atomically here; if a concurrent
    // reservation took the remaining daily budget, it becomes a review instead (a human may still approve it), and it
    // must not be signed. Recording after this keeps the persisted history, the response and any review in agreement.
    let evaluation = evaluation0;
    let reserved: SpendReservation | undefined;
    if (evaluation.decision === "ALLOW") {
      const attempt = reserveAutoAllow(policy, evaluation, gasCost);
      if (attempt === null) evaluation = { ...evaluation, decision: "NEEDS_REVIEW", reasons: evaluation.reasons.concat(DAILY_LIMIT_RACE_REASON) };
      else reserved = attempt;
    }
    const logEntry = recordEvaluation(parsed.data.agentId, policy.policyId, evaluation, customer?.id, "evm-sign");

    let spentApproval: string | undefined;
    if (evaluation.decision === "NEEDS_REVIEW") {
      if (!parsed.data.reviewId) return respondNeedsReview(res, `evm:${t.chainId}`, parsed.data.agentId, policy, evaluation, logEntry, customer, undefined, messageHash);
      const context = { agentId: parsed.data.agentId, policyId: policy.policyId, policyFingerprint: policyFingerprint(policy) };
      const outcome = reviewStore.consumeApproved(parsed.data.reviewId, messageHash, customer?.id, context);
      if (outcome !== "ok") return refuseApproval(res, customer?.id, parsed.data.reviewId, outcome, { ...context, logEntryId: logEntry.id });
      spentApproval = parsed.data.reviewId;
      // A human approval overrode the daily-limit review for this exact transaction: charge it unconditionally.
      reserved = recordSpend(policy.policyId, evaluation, gasCost);
    }
    if (reserved === undefined) {
      // Unreachable: every path that reaches signing has reserved above. Fail closed rather than sign without one.
      return res.status(500).json({ error: "RESERVATION_MISSING", message: "Internal error: no spend reservation before signing." });
    }
    const evmContext = () => ({ logEntryId: logEntry.id, agentId: parsed.data.agentId, policyId: policy.policyId, viaReview: spentApproval, messageHash, signer: signer.address });
    try {
      const signedTransaction = await signer.signTransaction(tx);
      if (parsed.data.broadcast) {
        // The signed bytes never leave the server. Re-read the code behind the destinations with no cache right
        // before sending, so a swap of what sits at the address after the first check is caught.
        const late = config.evmCodeLookup ? await codeCheckReasons(decodeEvmTransaction(tx), policy, tx.chainId, config.evmCodeLookup, true) : [];
        authorizeSigning(customer, policy);
        if (late.length > 0) {
          if (spentApproval) reviewStore.releaseConsumed(spentApproval);
          dailySpend.release(reserved);
          auditAfterSigning(customer?.id, "signing_failed", { ...evmContext(), outcome: "NOT_SENT", code: "DESTINATION_CHANGED", reasons: late });
          return res.status(409).json({ error: "DESTINATION_CHANGED", message: "The destination changed after the first check; nothing was sent.", reasons: late });
        }
        let transactionHash: string;
        try {
          transactionHash = await config.evmBroadcaster!(tx.chainId, signedTransaction);
        } catch (error) {
          // A timeout or an error after the node took the transaction means it may still be mined, so the budget
          // and the approval stay spent. Releasing them would let the same value go out twice.
          console.error("EVM broadcast failed:", error);
          auditAfterSigning(customer?.id, "signing_failed", { ...evmContext(), outcome: "UNKNOWN", code: "EVM_BROADCAST_FAILED" });
          return res.status(502).json({ error: "EVM_BROADCAST_FAILED", message: "The transaction was signed but the network did not confirm it was accepted. Its outcome is unknown; budget and approval stay spent. Check the signer's nonce before retrying." });
        }
        auditAfterSigning(customer?.id, "signed", { ...evmContext(), transactionHash, broadcast: true });
        return res.status(200).type("application/json").send(toJsonSafe({ ...evaluation, logEntryId: logEntry.id, transactionHash, signer: signer.address, ...(spentApproval ? { signedViaReview: spentApproval } : {}) }));
      }
      authorizeSigning(customer, policy);
      auditAfterSigning(customer?.id, "signed", { ...evmContext(), broadcast: false, signedTransactionSha256: createHash("sha256").update(String(signedTransaction)).digest("hex") });
      return res.status(200).type("application/json").send(toJsonSafe({ ...evaluation, logEntryId: logEntry.id, signedTransaction, signer: signer.address, ...(spentApproval ? { signedViaReview: spentApproval } : {}) }));
    } catch (error) {
      // Nothing was signed, so the approval and the budget both go back.
      if (spentApproval) reviewStore.releaseConsumed(spentApproval);
      dailySpend.release(reserved);
      if (error instanceof SigningAuthorizationError) {
        auditAfterSigning(customer?.id, "signing_failed", { ...evmContext(), outcome: "NOT_SENT", code: error.code });
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      console.error("EVM signing failed:", error);
      auditAfterSigning(customer?.id, "signing_failed", { ...evmContext(), outcome: "NOT_SENT", code: "EVM_SIGNING_FAILED" });
      return res.status(500).json({ error: "EVM_SIGNING_FAILED", message: "The signer could not sign this transaction." });
    }
  }));

  app.post("/gate-and-sign", transactionRateLimited, safe(async (req, res) => {
    const result = await evaluateTransactionRequest(req.body, customerOf(res), () => true);
    if ("status" in result) return res.status(result.status).json(result.body);
    const { agentId, reviewId, transactionBase64, evaluation, logEntry, policy } = result;
    let reserved = result.reserved;

    // A human-approved review lets this exact transaction through despite NEEDS_REVIEW. The approval is
    // spent atomically (single use), so two concurrent calls cannot both sign, and it is checked against
    // the message hash recorded when the review was created, so it cannot be reused for another transaction.
    let spentApproval: string | undefined;
    if (evaluation.decision === "NEEDS_REVIEW") {
      if (!reviewId) return respondNeedsReview(res, "solana", agentId, policy, evaluation, logEntry, customerOf(res), transactionBase64);
      const context = { agentId, policyId: policy.policyId, policyFingerprint: policyFingerprint(policy) };
      const outcome = reviewStore.consumeApproved(reviewId, transactionMessageHash(transactionBase64), customerOf(res)?.id, context);
      if (outcome !== "ok") return refuseApproval(res, customerOf(res)?.id, reviewId, outcome, { ...context, logEntryId: logEntry.id });
      spentApproval = reviewId;
      reserved = recordSpend(logEntry.policyId, evaluation);
    }
    // The daily budget was reserved when the transaction was evaluated; if nothing gets signed, give it back.
    const giveBackBudget = () => { if (reserved) dailySpend.release(reserved); };

    const solanaContext = () => ({ logEntryId: logEntry.id, agentId, policyId: logEntry.policyId, viaReview: spentApproval, transactionHash: transactionMessageHash(transactionBase64) });
    if (!config.koraGate) {
      if (spentApproval) reviewStore.releaseConsumed(spentApproval);
      giveBackBudget();
      auditAfterSigning(customerOf(res)?.id, "signing_failed", { ...solanaContext(), outcome: "NOT_SENT", code: "KORA_NOT_CONFIGURED" });
      return res.status(503).json({
        error: "KORA_NOT_CONFIGURED",
        message: "Policy ALLOWed this transaction, but no Kora client is configured to sign it."
      });
    }

    try {
      const signed = await signThroughKora(config.koraGate, transactionBase64, () => authorizeSigning(customerOf(res), policy));
      auditAfterSigning(customerOf(res)?.id, "signed", { ...solanaContext(), signature: (signed as { signature?: unknown }).signature });
      return res.status(200).type("application/json").send(toJsonSafe({ ...evaluation, logEntryId: logEntry.id, kora: signed, ...(spentApproval ? { signedViaReview: spentApproval } : {}) }));
    } catch (error) {
      // The approval is always given back: the same message makes the same transaction, which the chain
      // accepts once, so a retry cannot double-execute.
      if (spentApproval) reviewStore.releaseConsumed(spentApproval);
      if (error instanceof SigningAuthorizationError) {
        giveBackBudget();
        auditAfterSigning(customerOf(res)?.id, "signing_failed", { ...solanaContext(), outcome: "NOT_SENT", code: error.code });
        return res.status(error.status).json({ error: error.code, message: error.message });
      }
      if (error instanceof KoraFeePayerMismatchError) {
        // Checked before anything is sent, so this is a certain failure and the budget goes back.
        giveBackBudget();
        auditAfterSigning(customerOf(res)?.id, "signing_failed", { ...solanaContext(), outcome: "NOT_SENT", code: "KORA_FEE_PAYER_MISMATCH" });
        return res.status(400).json({ error: "KORA_FEE_PAYER_MISMATCH", message: error.message });
      }
      if (error instanceof KoraFeePayerInInstructionError) {
        giveBackBudget();
        auditAfterSigning(customerOf(res)?.id, "signing_failed", { ...solanaContext(), outcome: "NOT_SENT", code: "KORA_FEE_PAYER_IN_INSTRUCTION" });
        return res.status(400).json({ error: "KORA_FEE_PAYER_IN_INSTRUCTION", message: error.message });
      }
      if (isSimulationRejection(error)) {
        giveBackBudget();
        auditAfterSigning(customerOf(res)?.id, "signing_failed", { ...solanaContext(), outcome: "NOT_SENT", code: "KORA_SIMULATION_FAILED" });
        return res.status(422).json({ error: "KORA_SIMULATION_FAILED", outcome: "NOT_SENT", message: "The transaction failed simulation. Nothing was sent and the budget was given back." });
      }
      // Any other failure (a timeout, a dropped connection, an error reply) may have come after the
      // transaction was broadcast. The budget stays reserved: over-counting is safe, handing it back
      // when the money actually moved would let the daily cap be exceeded.
      auditAfterSigning(customerOf(res)?.id, "signing_failed", { ...solanaContext(), outcome: "UNKNOWN", code: "KORA_SIGNING_FAILED" });
      return res.status(502).json({
        error: "KORA_SIGNING_FAILED",
        outcome: "UNKNOWN",
        message: "The signing service did not confirm the outcome. The transaction may or may not have been sent; check its status before resubmitting. Its budget stays reserved until the day ends."
      });
    }
  }));

  app.post("/squads/upgrade-check", transactionRateLimited, safe(async (req, res) => {
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
      return res.status(502).json({ error: "SQUADS_READ_FAILED", message: "The proposal could not be read from the configured RPC service." });
    }
  }));

  // Lets an agent learn what happened to a review it was sent (poll this, then retry /gate-and-sign with reviewId).
  app.get("/reviews/:id", transactionRateLimited, (req, res) => {
    const review = reviewStore.get(req.params.id);
    if ((review?.customerId ?? undefined) !== customerOf(res)?.id || !review) return res.status(404).json({ error: "REVIEW_NOT_FOUND" });
    return res.status(200).type("application/json").send(toJsonSafe({
      id: review.id,
      status: review.status,
      reasons: review.evaluation.reasons,
      createdAt: review.createdAt,
      expiresAt: review.expiresAt,
      resolvedAt: review.resolvedAt,
      resolvedBy: review.resolvedBy?.kind === "reviewer" ? review.resolvedBy.name : review.resolvedBy ? "shared secret" : undefined,
      used: review.consumedAt !== undefined,
      policyId: review.policyId,
      policyFingerprint: review.policyFingerprint
    }));
  });

  // The caller's own append-only audit trail. Page with ?after=<n of the last event you have>&limit=<1..1000>.
  app.get("/audit", transactionRateLimited, (req, res) => {
    const whole = (value: unknown, fallback: number): number | undefined => value === undefined ? fallback : typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
    const after = whole(req.query.after, 0);
    const limit = whole(req.query.limit, 100);
    if (after === undefined || limit === undefined) return res.status(400).json({ error: "INVALID_REQUEST", message: "after and limit must be whole numbers." });
    const events = auditLog.list(customerOf(res)?.id, { after, limit });
    return res.status(200).type("application/json").send(toJsonSafe({ events, next: events.at(-1)?.n ?? after }));
  });

  // Recomputes the caller's whole chain. Keep headHash somewhere the database owner cannot write, to detect truncation.
  app.get("/audit/verify", transactionRateLimited, (_req, res) => {
    return res.status(200).json(auditLog.verify(customerOf(res)?.id));
  });

  app.get("/transactions/:id", transactionRateLimited, (req, res) => {
    const entry = evaluationLog.get(req.params.id, customerOf(res)?.id);
    if (!entry) return res.status(404).json({ error: "LOG_ENTRY_NOT_FOUND" });
    return res.status(200).type("application/json").send(toJsonSafe(entry));
  });

  app.get("/agents/:agentId/history", transactionRateLimited, (req, res) => {
    const customerId = customerOf(res)?.id;
    const decisionParam = req.query.decision;
    const decision = decisionParam === "ALLOW" || decisionParam === "NEEDS_REVIEW" ? decisionParam : undefined;
    const limitParam = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    // The log grows without bound between prunes, so one request never reads more than HISTORY_MAX_LIMIT rows.
    const limit = limitParam !== undefined && Number.isFinite(limitParam) && limitParam >= 0 ? Math.min(limitParam, HISTORY_MAX_LIMIT) : HISTORY_DEFAULT_LIMIT;

    const entries = evaluationLog.query({ agentId: req.params.agentId, decision, limit, customerId });
    const summary = evaluationLog.summaryByAgent(req.params.agentId, customerId);
    return res.status(200).type("application/json").send(toJsonSafe({ summary, entries }));
  });

  if (config.turnkey) {
    /**
     * The tenant a guarded wallet acts as, or undefined meaning "refuse". A wallet with no customerId is
     * intentionally unscoped (open mode) and resolves to { customer: undefined }, using a server-wide policy.
     * A wallet whose explicit customerId is missing or revoked resolves to undefined: it must fail closed and
     * must never fall back to a global policy. Checked at every boundary that can authorize a new approval.
     */
    const tenantFor = (wallet: GuardedWallet): { customer?: Customer } | undefined => {
      if (wallet.customerId === undefined) return { customer: undefined };
      const customer = customers.getActive(wallet.customerId);
      return customer ? { customer } : undefined;
    };
    const policyFor = (wallet: GuardedWallet): Policy | undefined => {
      const tenant = tenantFor(wallet);
      if (!tenant) return undefined; // explicit customer missing or revoked: no policy, fail closed
      return tenant.customer ? customers.getPolicy(tenant.customer.id, wallet.policyId) : policies.get(wallet.policyId);
    };
    const approver = new TurnkeyApprover({
      api: config.turnkey.api,
      wallets: new Map(Object.entries(config.turnkey.wallets)),
      lifecycle: turnkeyLifecycle,
      pollMs: config.turnkey.pollMs,
      retry: config.turnkey.retry,
      now: config.turnkey.now,
      random: config.turnkey.random,
      gate: {
        transactionHash: (transactionBase64) => transactionMessageHash(transactionBase64),
        policyFingerprint(wallet) {
          const policy = policyFor(wallet);
          return policy ? policyFingerprint(policy) : undefined;
        },
        async evaluate(transactionBase64, wallet, activityKey) {
          const tenant = tenantFor(wallet);
          // An explicitly scoped wallet whose customer is missing or revoked fails closed here: it is never
          // evaluated as an unscoped request against a global policy, so it can never produce an approve vote.
          if (!tenant) throw new Error("TENANT_UNAUTHORIZED: the wallet's customer is missing or revoked.");
          const customer = tenant.customer;
          const result = await evaluateTransactionRequest({ agentId: wallet.agentId, policyId: wallet.policyId, transactionBase64 }, customer, () => true, activityKey);
          if ("status" in result) throw new Error(`${result.status} ${JSON.stringify(result.body)}`);
          const fingerprint = policyFingerprint(result.policy);
          if (result.evaluation.decision === "ALLOW") return { allowed: true, reservation: result.reserved, policyFingerprint: fingerprint };
          return { allowed: false, reviewId: openReview("solana", wallet.agentId, result.policy, result.evaluation, result.logEntry, customer, transactionBase64, undefined, activityKey).review.id, policyFingerprint: fingerprint };
        },
        heldReservation: (activityKey) => dailySpend.held(activityKey),
        reviewStatus(reviewId) {
          return reviewStore.get(reviewId)?.status ?? "MISSING";
        },
        consumeApproval(reviewId, transactionBase64, wallet, activityKey) {
          const policy = policyFor(wallet);
          const review = reviewStore.get(reviewId);
          if (!policy || !review) return { ok: false, outcome: "not_found" };
          const outcome = reviewStore.consumeApproved(reviewId, transactionMessageHash(transactionBase64), wallet.customerId, { agentId: wallet.agentId, policyId: policy.policyId, policyFingerprint: policyFingerprint(policy) }, activityKey);
          if (outcome !== "ok") {
            audit(wallet.customerId, "approval_refused", { reviewId, reason: outcome, agentId: wallet.agentId, policyId: policy.policyId, via: "turnkey" });
            return { ok: false, outcome };
          }
          return { ok: true, reservation: recordSpend(policy.policyId, review.evaluation, {}, activityKey) };
        },
        recoverApproval(reviewId, transactionBase64, wallet, activityKey) {
          const policy = policyFor(wallet);
          const review = reviewStore.get(reviewId);
          if (!policy || !review) return { ok: false, outcome: "not_found" };
          const outcome = reviewStore.spentBy(reviewId, transactionMessageHash(transactionBase64), wallet.customerId, { agentId: wallet.agentId, policyId: policy.policyId, policyFingerprint: policyFingerprint(policy) }, activityKey);
          if (outcome !== "ok") {
            audit(wallet.customerId, "approval_refused", { reviewId, reason: outcome, agentId: wallet.agentId, policyId: policy.policyId, via: "turnkey_recovery" });
            return { ok: false, outcome };
          }
          // The charge is keyed by the activity, so this finds the one made before the crash, or makes it if the crash came first.
          return { ok: true, reservation: recordSpend(policy.policyId, review.evaluation, {}, activityKey) };
        },
        releaseBudget: (reservation) => dailySpend.release(reservation),
        record(wallet, event, data) {
          auditAfterSigning(wallet.customerId, event, { agentId: wallet.agentId, policyId: wallet.policyId, ...data });
        }
      }
    });
    app.locals.turnkeyApprover = approver;
    if (config.turnkey.autoStart !== false) approver.start();
    // A Turnkey webhook only makes the next poll happen now. Its body is not read: every activity is fetched
    // from Turnkey's own API before it is judged, so a forged webhook can at most cause an extra poll.
    app.post("/turnkey/webhook", rateLimited("turnkey-webhook"), (_req, res) => {
      void approver.poll();
      res.status(202).json({ accepted: true });
    });
  }

  app.use((error: unknown, _req: express.Request, res: Response, next: express.NextFunction) => {
    if (error instanceof SigningAuthorizationError && !res.headersSent) {
      return res.status(error.status).json({ error: error.code, message: error.message });
    }
    // The body parser reports a client mistake (malformed JSON, body too large) as an error with a 4xx status.
    const status = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500 && !res.headersSent) {
      return res.status(status).json({ error: status === 413 ? "REQUEST_TOO_LARGE" : "INVALID_REQUEST", message: status === 413 ? "The request body is too large." : "The request body is not valid JSON." });
    }
    console.error("Unhandled request error:", error);
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "The request failed. Nothing was signed." });
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
