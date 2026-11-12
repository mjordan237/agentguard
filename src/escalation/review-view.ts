import type { PolicyEvaluation } from "../policy/types.js";
import type { AuditEvent } from "../observability/audit-log.js";
import type { ActivityRecord, LifecycleState } from "../turnkey/lifecycle-store.js";
import type { PendingReview } from "./pending-store.js";
import { classifyInstruction, type Operation } from "../policy/operation.js";

/**
 * What the operator queue and review page say about a review, worked out from stored records only. Each of the
 * four steps (policy check, reviewer decision, approval use, outcome) is reported separately: an approved review
 * is not a spent approval, a spent approval is not a signature, and a signature is not an executed transaction.
 */

/** Amounts are base units as decoded (lamports, wei, token base units); no decimals are assumed. */
export interface TransactionSummary {
  text: string;
  instructions: number;
  /** Instructions AgentGuard could not decode. */
  undecoded: number;
  transfers: number;
  swaps: number;
  approvals: number;
  /** At least one approval with no practical limit. */
  unlimitedApproval: boolean;
  /** Per asset, only for decoded transfers. Totals are never added across assets. */
  assets: Array<{ asset: string; total: bigint; transfers: number }>;
  destinations: number;
  /** Set only when there is exactly one decoded transfer. */
  single?: { destination: string; amount: bigint; asset: string };
  /** Every instruction, classified (see src/policy/operation.ts). */
  operations: Operation[];
}

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const unknown = (value: string | undefined) => value ?? "an unrecorded address";

function describeOperation(op: Operation): string {
  switch (op.kind) {
    case "approval":
      return `${op.unlimited ? "Unlimited approval" : "Approval"}${op.bySignature ? " by signature" : ""}: lets ${unknown(op.counterparty)} spend ${op.unlimited ? "any amount of" : `up to ${op.amount ?? "an unrecorded amount of"}`} ${op.asset ?? "an unrecorded asset"}`;
    case "allowance_revoke":
      return `Revokes the allowance of ${unknown(op.counterparty)} on ${op.asset ?? "an unrecorded asset"}${op.bySignature ? " by signature" : ""}`;
    case "nft_operator_approval":
      return `Gives ${unknown(op.counterparty)} control of every NFT in ${op.asset ?? op.programId}`;
    case "nft_operator_revoke":
      return `Removes ${unknown(op.counterparty)} as operator of ${op.asset ?? op.programId}`;
    case "swap":
      return `Swap of up to ${op.amount ?? "an unrecorded amount of"} ${op.asset ?? "an unrecorded asset"} for ${op.minimumOut !== undefined ? `at least ${op.minimumOut} ` : ""}${op.assetOut ?? "an unrecorded asset"}`;
    case "wrap":
      return `Wraps ${op.amount ?? "an unrecorded amount of"} native into its wrapped token`;
    case "unwrap":
      return `Unwraps ${op.amount !== undefined ? `${op.amount} ` : ""}${op.asset ?? "wrapped native"}`;
    default:
      return op.instructionName;
  }
}

export function summarizeTransaction(evaluation: PolicyEvaluation): TransactionSummary {
  const operations = evaluation.decoded.instructions.map(classifyInstruction);
  const transfers = operations.filter((op) => op.kind === "transfer");
  const byAsset = new Map<string, { total: bigint; transfers: number }>();
  for (const t of transfers) {
    const asset = t.asset ?? "native";
    const entry = byAsset.get(asset) ?? { total: 0n, transfers: 0 };
    entry.total += t.amount!;
    entry.transfers += 1;
    byAsset.set(asset, entry);
  }
  const assets = [...byAsset].map(([asset, entry]) => ({ asset, ...entry }));
  const destinations = new Set(transfers.map((t) => t.counterparty)).size;
  const count = (kind: Operation["kind"]) => operations.filter((op) => op.kind === kind).length;
  const undecoded = count("undecoded");
  const others = operations.filter((op) => op.kind === "other");
  const approvals = operations.filter((op) => op.kind === "approval");

  // Authority grants first: they matter most and are easy to miss among payments.
  const parts: string[] = [];
  const grants = operations.filter((op) => ["approval", "allowance_revoke", "nft_operator_approval", "nft_operator_revoke"].includes(op.kind));
  if (grants.length <= 3) parts.push(...grants.map(describeOperation));
  else parts.push(`${plural(grants.length, "approval or revocation", "approvals or revocations")}${approvals.some((a) => a.unlimited) ? `, ${approvals.filter((a) => a.unlimited).length} unlimited` : ""}`);
  let single: TransactionSummary["single"];
  if (transfers.length === 1) {
    const t = transfers[0]!;
    single = { destination: unknown(t.counterparty), amount: t.amount!, asset: t.asset ?? "native" };
    parts.push(`Transfer of ${single.amount} ${single.asset} to ${single.destination}`);
  } else if (transfers.length > 1) {
    parts.push(assets.length === 1
      ? `${plural(transfers.length, "transfer")} totalling ${assets[0]!.total} ${assets[0]!.asset} to ${plural(destinations, "destination")}`
      : `${plural(transfers.length, "transfer")} across ${plural(assets.length, "asset")} to ${plural(destinations, "destination")}`);
  }
  const swaps = operations.filter((op) => op.kind === "swap");
  if (swaps.length === 1) parts.push(describeOperation(swaps[0]!));
  else if (swaps.length > 1) parts.push(plural(swaps.length, "swap"));
  parts.push(...operations.filter((op) => op.kind === "wrap" || op.kind === "unwrap").map(describeOperation));
  if (others.length) parts.push(`${plural(others.length, "other instruction")} (${[...new Set(others.map((op) => op.instructionName))].slice(0, 3).join(", ")}${new Set(others.map((op) => op.instructionName)).size > 3 ? ", ..." : ""})`);
  if (undecoded) parts.push(`${plural(undecoded, "instruction")} could not be decoded`);
  if (operations.length === 0) parts.push("No instructions decoded");
  return {
    text: parts.join("; "), instructions: operations.length, undecoded, transfers: transfers.length, swaps: swaps.length,
    approvals: approvals.length, unlimitedApproval: approvals.some((a) => a.unlimited === true), assets, destinations, single, operations
  };
}

/** Stable codes AgentGuard records when it refuses to use an approval or rejects a Turnkey request, with a short meaning. */
const CODES: Record<string, string> = {
  not_found: "The review was not found for this caller.",
  not_approved: "The review was not approved.",
  mismatch: "The transaction, agent or policy did not match the reviewed one.",
  already_used: "The approval had already been used.",
  stale: "The approval was too old to use.",
  policy_changed: "The policy's rules changed after the review.",
  not_consumed: "The approval had not been used by this request.",
  consumed_elsewhere: "The approval was used by another request.",
  ASSIGNMENT_CHANGED: "The wallet was reassigned to another customer, agent or policy, so the request was rejected.",
  KORA_NOT_CONFIGURED: "No signing service was configured; nothing was sent.",
  KORA_FEE_PAYER_MISMATCH: "The fee payer did not match the signing service; nothing was sent.",
  KORA_FEE_PAYER_IN_INSTRUCTION: "The fee payer appeared in an instruction; nothing was sent.",
  KORA_SIMULATION_FAILED: "Simulation rejected the transaction; nothing was sent.",
  KORA_SIGNING_FAILED: "The signing service failed; the transaction may or may not have been sent.",
  EVM_SIGNING_FAILED: "The signer could not sign; nothing was sent.",
  EVM_BROADCAST_FAILED: "Signed, but the network did not confirm it took the transaction; outcome unknown.",
  DESTINATION_CHANGED: "A destination's code changed before broadcast; nothing was sent.",
  VOTE_PENDING: "Turnkey is still processing AgentGuard's vote.",
  VOTE_NOT_COMPLETED: "AgentGuard's vote activity ended without completing, so that vote was not recorded.",
  VOTE_OUTCOME_UNKNOWN: "Sending AgentGuard's vote failed in a way that does not show whether Turnkey received it.",
  VOTE_RATE_LIMITED: "Turnkey rate-limited AgentGuard's vote; it is retried after a backoff.",
  VOTE_NO_ACTIVITY_ID: "Turnkey's answer to the vote named no vote activity; the same request is sent again later.",
  VOTE_STATUS_UNREADABLE: "AgentGuard could not read the status of its vote activity; it asks again after a backoff.",
  VOTE_ATTEMPTS_EXHAUSTED: "AgentGuard stopped sending new votes after its limit and now only watches the signing request.",
  VOTE_REFUSED: "Turnkey refused AgentGuard's approve vote.",
  REJECT_ATTEMPTS_EXHAUSTED: "AgentGuard stopped sending new reject requests after its limit and now only watches the signing request.",
  OBSERVATION_ENDED: "AgentGuard stopped watching the signing request at the end of its observation period; an operator should check it in Turnkey.",
  UNSUPPORTED_ACTIVITY: "The request was not a Solana signature AgentGuard can check, so it was refused.",
  UNREADABLE_TRANSACTION: "The request's transaction could not be read, so it was refused.",
  ACCOUNTING_RETAINED: "The charge stays counted because no signature can be ruled out."
};

export function explainCode(code: string): string {
  const approval = code.startsWith("APPROVAL_") ? code.slice("APPROVAL_".length).toLowerCase() : undefined;
  return CODES[code] ?? (approval && CODES[approval] ? CODES[approval]! : "No description recorded for this code.");
}

/** The code at the front of a lifecycle record's detail ("CODE: text"), if it has one. The rest is not shown on public pages. */
export function codeOf(detail: string | undefined): string | undefined {
  return detail?.match(/^([A-Z][A-Z_]+): /)?.[1];
}

export const LIFECYCLE_LABELS: Record<LifecycleState, { label: string; meaning: string; tone: "wait" | "good" | "bad" | "unknown" | "neutral" }> = {
  EVALUATING: { label: "Being checked", meaning: "AgentGuard is checking the Turnkey signing request.", tone: "wait" },
  REVIEW_OPEN: { label: "Waiting for review", meaning: "The Turnkey signing request waits for this review's decision.", tone: "wait" },
  VOTING: { label: "Submitting vote", meaning: "The approval was used and AgentGuard's approve vote is being sent to Turnkey.", tone: "wait" },
  VOTE_PENDING: { label: "Vote submission pending", meaning: "Turnkey took AgentGuard's approve vote but has not finished processing it. AgentGuard checks that vote, without sending another, until it does.", tone: "wait" },
  VOTE_UNKNOWN: { label: "Outcome unknown", meaning: "Whether AgentGuard's approve vote counted is not known. AgentGuard keeps checking the signing request and may retry the vote a limited number of times.", tone: "unknown" },
  REJECT_PENDING: { label: "Rejecting", meaning: "AgentGuard decided to reject; its reject vote has not completed yet and is being retried or checked.", tone: "wait" },
  APPROVED: { label: "Vote completed", meaning: "AgentGuard's approve vote completed in Turnkey. The signing request may still need other approvers, so AgentGuard keeps reading it, without voting again, until Turnkey finishes it or 7 days pass. This does not show that the transaction was signed or executed on chain.", tone: "good" },
  SIGNING_COMPLETED: { label: "Original signing request completed", meaning: "Turnkey reports the signing request itself completed, so Turnkey produced the signature, whether after AgentGuard's vote or another approver's. Whether the transaction executed on chain is not recorded here.", tone: "good" },
  VOTE_REFUSED: { label: "Vote refused", meaning: "Turnkey refused AgentGuard's approve vote. The signing request could still complete another way, so the approval stays used and AgentGuard keeps reading the request until Turnkey finishes it or 7 days pass.", tone: "bad" },
  REJECTED: { label: "Rejected", meaning: "AgentGuard's reject vote completed in Turnkey.", tone: "bad" },
  RESOLVED_EXTERNALLY: { label: "Resolved in Turnkey", meaning: "Turnkey finished the signing request as rejected or failed without AgentGuard deciding it.", tone: "neutral" },
  SIGNING_UNRESOLVED: { label: "Signing outcome not observed", meaning: "AgentGuard stopped checking after 7 days without Turnkey finishing the signing request. Check the request in Turnkey and settle it there; AgentGuard does not assume it was or was not signed.", tone: "unknown" },
  MISMATCH: { label: "Mismatch, rejected", meaning: "The request, its wallet, or the wallet's assignment no longer matched what was reviewed, so it was rejected.", tone: "bad" }
};

/**
 * A charge stays counted after an approve vote may have been submitted, until the day rolls over, unless the request
 * was signed (then it is simply spent). Shown so an operator knows the day's total may be higher than what was signed.
 */
const ACCOUNTING_RETAINED = "Accounting retained pending reconciliation: the budget charged for this request stays counted, because AgentGuard cannot prove that no signature was produced. This can overcount the day's spending.";
const retainsAccounting = (activity: ActivityRecord) => activity.reservation !== undefined && activity.state !== "APPROVED" && activity.state !== "SIGNING_COMPLETED";

export type ReviewOutcome =
  | { kind: "turnkey"; state: LifecycleState; label: string; meaning: string; tone: string; accountingRetained: boolean; code?: string; codeMeaning?: string; since: string; activityId: string; organizationId: string }
  | { kind: "signing"; label: string; meaning: string; tone: string; at: string; code?: string; codeMeaning?: string; reference?: string }
  | { kind: "none"; label: string; meaning: string; tone: string };

/** What happened after the decision, from the Turnkey record or the direct-signing audit event; never inferred. */
export function describeOutcome(activity: ActivityRecord | undefined, signing: AuditEvent | undefined, reviewStatus: PendingReview["status"]): ReviewOutcome {
  if (activity) {
    const known = turnkeyLabel(activity.state, reviewStatus);
    const code = codeOf(activity.detail);
    const retained = retainsAccounting(activity);
    return {
      kind: "turnkey", state: activity.state, ...known, meaning: retained ? `${known.meaning} ${ACCOUNTING_RETAINED}` : known.meaning, accountingRetained: retained,
      ...(code ? { code, codeMeaning: explainCode(code) } : {}), since: activity.updatedAt, activityId: activity.activityId, organizationId: activity.organizationId
    };
  }
  if (signing?.type === "signed") {
    // /gate-and-sign-evm records the signer and whether it broadcast; /gate-and-sign goes through Kora, which signs and sends.
    const evm = typeof signing.data.signer === "string";
    const sent = evm ? signing.data.broadcast === true : true;
    const reference = evm ? (sent && typeof signing.data.transactionHash === "string" ? signing.data.transactionHash : undefined) : typeof signing.data.signature === "string" ? signing.data.signature : undefined;
    return {
      kind: "signing", tone: "good", at: signing.at, ...(reference ? { reference } : {}),
      label: sent ? "Signed and sent" : "Signed, not sent",
      meaning: sent
        ? `${evm ? "The transaction was signed and the network node accepted it." : "Kora signed the transaction and reported sending it."} Whether it executed on chain is not recorded here.`
        : "A signed transaction was returned to the caller. Whether it was sent or executed is not recorded here."
    };
  }
  if (signing?.type === "signing_failed") {
    const code = typeof signing.data.code === "string" ? signing.data.code : undefined;
    const unknown = signing.data.outcome === "UNKNOWN";
    return {
      kind: "signing", tone: unknown ? "unknown" : "bad", at: signing.at, ...(code ? { code, codeMeaning: explainCode(code) } : {}),
      label: unknown ? "Signing outcome unknown" : "Signing failed, nothing sent",
      meaning: unknown ? "Signing failed in a way that may have come after the transaction was sent. The budget stays reserved." : "Signing failed before anything was sent."
    };
  }
  return { kind: "none", tone: "neutral", label: "No recorded signing outcome", meaning: "No signing result or Turnkey vote is recorded for this review." };
}

/** The Turnkey state as a reviewer should read it. REVIEW_OPEN after the decision means AgentGuard has not acted on it yet. */
function turnkeyLabel(state: LifecycleState, reviewStatus: PendingReview["status"]) {
  if (state === "REVIEW_OPEN" && reviewStatus !== "PENDING") {
    return { label: "Decision not yet acted on", meaning: "The review is decided, but AgentGuard has not yet voted on the Turnkey request. It does so on its next pass.", tone: "wait" as const };
  }
  return LIFECYCLE_LABELS[state];
}

export function chainLabel(chain: string | undefined): string {
  if (!chain) return "Unknown";
  if (chain === "solana") return "Solana";
  if (chain === "evm") return "EVM (chain not stated)";
  const id = chain.match(/^evm:(\d+)$/)?.[1];
  return id ? `EVM chain ${id}` : chain;
}

/** One queue row. Holds only what the queue shows; the review page and detail API carry the rest. */
export function queueItem(review: PendingReview, activity: ActivityRecord | undefined, showCustomer: boolean) {
  return {
    id: review.id,
    ...(showCustomer ? { customerId: review.customerId ?? null } : {}),
    agentId: review.agentId,
    chain: review.chain ?? null,
    chainLabel: chainLabel(review.chain),
    policyId: review.policyId ?? null,
    policyFingerprint: review.policyFingerprint ?? null,
    status: review.status,
    createdAt: review.createdAt,
    expiresAt: review.expiresAt,
    resolvedAt: review.resolvedAt ?? null,
    resolvedBy: review.resolvedBy ? (review.resolvedBy.kind === "reviewer" ? { kind: "reviewer", name: review.resolvedBy.name } : { kind: "shared-secret" }) : null,
    // A used approval means a signature or vote was attempted with it, not that one was made.
    approvalUsed: review.consumedAt !== undefined,
    approvalUsedAt: review.consumedAt ?? null,
    summary: (({ operations: _operations, ...rest }) => rest)(summarizeTransaction(review.evaluation)),
    reasons: review.evaluation.reasons,
    turnkey: activity ? { state: activity.state, label: turnkeyLabel(activity.state, review.status).label, updatedAt: activity.updatedAt } : null
  };
}

/** Records about a review kept by other stores, read once per detail request. */
export interface ReviewRecords {
  activity?: ActivityRecord;
  /** Newest `signed` / `signing_failed` audit event naming this review as viaReview. */
  signing?: AuditEvent;
  /** Newest `approval_refused` audit event for this review. */
  refusal?: AuditEvent;
  /** The reviewed policy's revision as it stands now; undefined when it cannot be told. */
  currentPolicyFingerprint?: string;
}

const actorText = (review: PendingReview) => !review.resolvedBy ? "" : review.resolvedBy.kind === "reviewer" ? ` by ${review.resolvedBy.name}` : " using the shared secret (no individual identified)";

/**
 * Everything the authenticated review page shows, as data. Wording lives here so it is tested once; the page
 * only places it, as text. `operator` callers (operator reviewers, the shared secret) also get free-text Turnkey
 * diagnostics, which can name another customer's assignment; a customer's reviewer gets only the stable code.
 */
export function reviewDetail(review: PendingReview, records: ReviewRecords, options: { operator: boolean }) {
  const outcome = describeOutcome(records.activity, records.signing, review.status);
  const currentPolicy: "matches" | "changed" | "unknown" = !review.policyFingerprint || records.currentPolicyFingerprint === undefined ? "unknown"
    : records.currentPolicyFingerprint === review.policyFingerprint ? "matches" : "changed";
  const refusalCode = typeof records.refusal?.data.reason === "string" ? records.refusal.data.reason : undefined;
  const decision = review.status === "PENDING" ? "Waiting for a reviewer."
    : review.status === "EXPIRED" ? `Not decided. The review expired at ${review.expiresAt}.`
      : `${review.status === "APPROVED" ? "Approved" : "Denied"}${actorText(review)} at ${review.resolvedAt ?? "an unknown time"}.`;
  const approvalUse = review.status !== "APPROVED" ? "Not applicable: only an approved review can be used."
    : review.consumedAt
      ? `Used at ${review.consumedAt}${review.consumedBy?.startsWith("turnkey:") ? " by the Turnkey request it was opened for" : " for a signing request"}. Using an approval is not proof that anything was signed.`
      : "Not used yet.";
  const activity = records.activity;
  return {
    ...queueItem(review, activity, options.operator),
    summary: summarizeTransaction(review.evaluation),
    feePayer: review.evaluation.decoded.feePayer,
    transactionHash: review.transactionHash ?? null,
    currentPolicy,
    currentPolicyText: currentPolicy === "matches" ? "The policy's current rules match the reviewed revision."
      : currentPolicy === "changed" ? "The policy's rules have changed since this review, so an approval of it can no longer be used."
        : "Cannot tell whether the policy's rules have changed.",
    steps: [
      { step: "policy", label: "Policy check", text: "Held for a person to review.", items: review.evaluation.reasons },
      { step: "decision", label: "Reviewer decision", text: decision },
      { step: "approval", label: "Approval use", text: approvalUse },
      {
        step: "outcome", label: "Outcome", badge: outcome.label, tone: outcome.tone,
        text: `${outcome.meaning}${outcome.kind === "turnkey" ? ` Recorded state since ${outcome.since}.` : outcome.kind === "signing" ? ` Recorded at ${outcome.at}.` : ""}`,
        ...("code" in outcome && outcome.code ? { code: outcome.code, codeMeaning: outcome.codeMeaning } : {})
      }
    ],
    outcome,
    lastRefusal: refusalCode ? { code: refusalCode, meaning: explainCode(refusalCode), at: records.refusal!.at } : null,
    warnings: review.chain === "solana" && review.status === "PENDING" && usesRecentBlockhash(review.evaluation) ? [RECENT_BLOCKHASH_WARNING] : [],
    turnkeyActivity: activity ? {
      activityId: activity.activityId, organizationId: activity.organizationId, state: activity.state, createdAt: activity.createdAt, updatedAt: activity.updatedAt,
      // AgentGuard's own vote is a separate Turnkey activity from the signing request above.
      vote: activity.voteKind ? { kind: activity.voteKind, activityId: activity.voteActivityId ?? null, status: activity.voteActivityStatus ?? null, requests: activity.voteSubmissions } : null,
      accountingRetained: retainsAccounting(activity),
      ...(activity.nextCheckAt ? { nextCheckAt: activity.nextCheckAt } : {}),
      ...(options.operator && activity.detail ? { detail: activity.detail } : {})
    } : null,
    instructions: review.evaluation.decoded.instructions,
    // Written by a model from untrusted transaction data. It decides nothing.
    advisoryExplanation: review.explanation ?? null,
    actionable: review.status === "PENDING"
  };
}

const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

/** A Solana transaction not starting with advanceNonceAccount uses a recent blockhash and expires within about a minute. */
export function usesRecentBlockhash(evaluation: PolicyEvaluation): boolean {
  const first = evaluation.decoded.instructions[0];
  return !(first?.programId === SYSTEM_PROGRAM_ID && first.instructionName === "advanceNonceAccount" && first.mode !== "raw_dump");
}

export const RECENT_BLOCKHASH_WARNING = "This transaction uses a recent blockhash, so it will likely expire before a person approves it, and an approval covers only these exact bytes. Build transactions that may need review with a durable nonce (see the README).";
