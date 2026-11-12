import type { TurnkeyActivity, TurnkeyApi, VoteSubmission } from "./api.js";
import { TERMINAL_STATUSES, TurnkeyApiError, VOTE_COMPLETED } from "./api.js";
import type { SpendReservation } from "../policy/daily-spend-tracker.js";
import type { ConsumeOutcome, SpentByOutcome } from "../escalation/pending-store.js";
import { isTerminal, TurnkeyLifecycleStore, type ActivityRecord, type ActivityUpdate, type LifecycleState } from "./lifecycle-store.js";
import { randomUUID } from "node:crypto";

/** One Turnkey wallet AgentGuard guards: whose rules apply and under which agent name its requests are logged. */
export interface GuardedWallet {
  policyId: string;
  agentId: string;
  customerId?: string;
}

/** What the server does for the approver. Kept narrow so the approver can be tested without a server. */
export interface TurnkeyGate {
  /** SHA-256 of the transaction's message, as reviews record it; undefined if it cannot be read. */
  transactionHash(transactionBase64: string): string | undefined;
  /** The current revision of the wallet's policy; undefined if the policy no longer exists. */
  policyFingerprint(wallet: GuardedWallet): string | undefined;
  /**
   * Decodes and checks the transaction as /gate-and-sign does. ALLOW reserves the budget under `activityKey`;
   * otherwise the review for `activityKey` is opened, or the one already open for it is returned. So running this
   * again for the same activity charges once and opens one review.
   */
  evaluate(transactionBase64: string, wallet: GuardedWallet, activityKey: string): Promise<
    { allowed: true; reservation?: SpendReservation; policyFingerprint: string } | { allowed: false; reviewId: string; policyFingerprint: string }>;
  /** The budget still held under `activityKey`, if any. */
  heldReservation(activityKey: string): SpendReservation | undefined;
  reviewStatus(reviewId: string): "PENDING" | "APPROVED" | "DENIED" | "EXPIRED" | "MISSING";
  /** Spends the approval of this exact transaction under the current policy revision, recording `activityKey` as what spent it, and reserves its budget under `activityKey`. */
  consumeApproval(reviewId: string, transactionBase64: string, wallet: GuardedWallet, activityKey: string): { ok: true; reservation: SpendReservation } | { ok: false; outcome: Exclude<ConsumeOutcome, "ok"> };
  /**
   * After a crash between consumeApproval and recording it: succeeds only if `activityKey` itself spent the approval
   * and it is still valid for this wallet, transaction and policy revision, and not stale. Returns the budget held
   * under `activityKey`, reserving it if the crash came before that. A held budget alone never proves this.
   */
  recoverApproval(reviewId: string, transactionBase64: string, wallet: GuardedWallet, activityKey: string): { ok: true; reservation: SpendReservation } | { ok: false; outcome: Exclude<SpentByOutcome, "ok"> };
  /**
   * Refunds a reservation. Idempotent: a reservation already refunded is not refunded again. Called only before any
   * approve vote for the activity was submitted; never on an answer from Turnkey (see TurnkeyApprover).
   */
  releaseBudget(reservation: SpendReservation): void;
  record(wallet: GuardedWallet, event: "turnkey_approved" | "turnkey_rejected" | "turnkey_failed" | "turnkey_review_linked" | "turnkey_resolved", data: Record<string, unknown>): void;
}

export interface TurnkeyApproverConfig {
  api: TurnkeyApi;
  /** Solana addresses of the guarded wallets. Activities for any other wallet are left alone. */
  wallets: Map<string, GuardedWallet>;
  gate: TurnkeyGate;
  /** Where activity records are kept. Defaults to memory, which does not survive a restart. */
  lifecycle?: TurnkeyLifecycleStore;
  pollMs?: number;
  /**
   * How long a standby waits before it may take over a lease. A pass can outlive this TTL; the fence detects tested
   * takeover cases before a new vote, but cannot recall an external request already in flight. Deploy one active
   * approver until multi-process state transitions and failover semantics are fully validated.
   */
  leaseTtlMs?: number;
  retry?: Partial<TurnkeyRetryPolicy>;
  /** Clock and randomness, for tests. */
  now?: () => number;
  random?: () => number;
}

/**
 * How AgentGuard waits and retries. Turnkey rate-limits submissions and status queries with HTTP 429, sends no
 * Retry-After header, and advises a short first delay then exponential backoff with jitter
 * (docs.turnkey.com/reference/rate-limits). A vote request is replayed with its original timestampMs, which Turnkey
 * accepts for one hour and answers with the same activity; a new timestampMs would create another vote.
 */
export interface TurnkeyRetryPolicy {
  /** First wait after a failure, or between checks of a pending vote; doubles each time, with ±20% jitter. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Distinct vote requests (new timestampMs) per signing activity before AgentGuard stops submitting and only watches. */
  maxVoteSubmissions: number;
  /** A recorded vote request is replayed only while its timestampMs is younger than this. */
  replayWindowMs: number;
  /**
   * How long AgentGuard keeps reading a signing activity after it has stopped voting on it (its vote completed or was
   * refused, or its vote requests ran out). After this the record becomes SIGNING_UNRESOLVED, for an operator.
   */
  watchHorizonMs: number;
}

export const DEFAULT_RETRY_POLICY: TurnkeyRetryPolicy = { baseDelayMs: 2_000, maxDelayMs: 5 * 60_000, maxVoteSubmissions: 3, replayWindowMs: 50 * 60_000, watchHorizonMs: 7 * 24 * 60 * 60_000 };

/** What /healthz reports about the approver. No Turnkey response text: that stays in the server log. */
export interface TurnkeyApproverStatus {
  lastPollAt?: string;
  /** The last poll whose scan of waiting activities finished without an error. */
  lastSuccessfulPollAt?: string;
  /** The last scan that reached the end of the list. A scan that stops at the page cap carries on next time. */
  lastCompleteScanAt?: string;
  lastScan?: { complete: boolean; pages: number; resumed: boolean };
  /** Scans in a row that failed part way; reset by a scan that does not. */
  consecutivePaginationFailures: number;
  unresolvedActivities: number;
  /** True when this process did not hold the poller lease at its last poll, so another process is the active poller. */
  standby?: boolean;
}

/** The one lease that gates which process advances the Turnkey lifecycle. */
const LEASE_NAME = "turnkey-approver";

const RECONCILE_PER_POLL = 50;

/** Turnkey activity statuses that mean it is finished: nothing AgentGuard does now can change it. */
const FINISHED = new Set(["ACTIVITY_STATUS_COMPLETED", "ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]);

/**
 * Turnkey's half of the gate. Customers write a Turnkey policy that needs AgentGuard as a second approver for each
 * guarded wallet; the agent's signing request then waits in CONSENSUS_NEEDED until this approves or rejects it.
 * Waiting activities are found by polling, and a webhook only makes the next poll happen sooner: nothing in a
 * webhook is trusted, and every activity is read from Turnkey's authenticated API before it is judged.
 *
 * Every activity AgentGuard takes on is recorded (see TurnkeyLifecycleStore) before anything is done about it, so
 * repeated polls, webhooks and restarts find the record instead of opening another review. A record that may have a
 * vote outstanding is only ever acted on after the activity is read back from Turnkey.
 */
export class TurnkeyApprover {
  private readonly inFlight = new Set<string>();
  private readonly lifecycle: TurnkeyLifecycleStore;
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private readonly diagnostics: Omit<TurnkeyApproverStatus, "unresolvedActivities"> = { consecutivePaginationFailures: 0 };

  private readonly retry: TurnkeyRetryPolicy;
  /** This process's identity for the poller lease: one per approver instance, so two instances never share a hold. */
  private readonly owner = randomUUID();
  private readonly leaseTtlMs: number;
  /** The fence token this process captured when it acquired the lease for the current poll pass (see poll). */
  private leaseFence?: number;

  constructor(private readonly config: TurnkeyApproverConfig) {
    this.lifecycle = config.lifecycle ?? new TurnkeyLifecycleStore();
    this.retry = { ...DEFAULT_RETRY_POLICY, ...config.retry };
    // Several poll intervals, so an active holder renews well before its own lease lapses.
    this.leaseTtlMs = config.leaseTtlMs ?? Math.max(30_000, (config.pollMs ?? 3_000) * 5);
  }

  private nowMs(): number { return this.config.now?.() ?? Date.now(); }

  /** When to look again after `attempt` consecutive failures (or pending checks): exponential, capped, ±20% jitter. */
  private later(attempt: number): string {
    const delay = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** Math.max(0, attempt - 1));
    const jitter = delay * 0.2 * (2 * (this.config.random?.() ?? Math.random()) - 1);
    return new Date(this.nowMs() + Math.max(0, Math.round(delay + jitter))).toISOString();
  }

  private due(record: ActivityRecord): boolean { return !record.nextCheckAt || Date.parse(record.nextCheckAt) <= this.nowMs(); }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.config.pollMs ?? 3_000);
    this.timer.unref();
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): TurnkeyApproverStatus {
    return { ...this.diagnostics, unresolvedActivities: this.lifecycle.unresolved(1_000).length };
  }

  /**
   * One pass: first re-read, from Turnkey, the activities already being handled whose state may have moved (a review
   * decided, a vote outstanding, a check interrupted by a restart); then scan the waiting list for new ones. Bounded:
   * at most RECONCILE_PER_POLL re-reads and one capped scan. Concurrent calls share one pass.
   */
  poll(): Promise<void> {
    this.polling ??= (async () => {
      // The lease gates entry to this pass; the fence also checks for takeover before a new distinct approve vote.
      // It is released at the end. This does not fence an external call already in flight or make every state write
      // atomic with ownership, so it is not a guarantee of exactly-once submission across replicas.
      let held = false;
      try {
        held = this.lifecycle.acquireLease(LEASE_NAME, this.owner, this.nowMs(), this.leaseTtlMs);
        if (!held) { this.diagnostics.standby = true; return; }
        this.diagnostics.standby = false;
        // Capture the fence token for this pass, so a privileged submission can check no other owner took over while
        // this pass was paused in an awaited call past the TTL (see approveVote and assertLease).
        this.leaseFence = this.lifecycle.leaseFence(LEASE_NAME);
        const handled = new Set<string>();
        await this.reconcile(handled);
        this.diagnostics.lastPollAt = new Date().toISOString();
        const scan = await this.config.api.scanWaitingActivities();
        for (const activity of scan.activities) {
          if (handled.has(this.keyOf(activity))) continue;
          await this.handle(activity);
        }
        this.diagnostics.lastScan = { complete: scan.complete, pages: scan.pages, resumed: scan.startedAfter !== undefined };
        if (scan.error) {
          this.diagnostics.consecutivePaginationFailures += 1;
          console.error("Turnkey scan stopped early:", scan.error);
        } else {
          this.diagnostics.consecutivePaginationFailures = 0;
          this.diagnostics.lastSuccessfulPollAt = this.diagnostics.lastPollAt;
          if (scan.complete) this.diagnostics.lastCompleteScanAt = this.diagnostics.lastPollAt;
        }
      } catch (error) {
        this.diagnostics.consecutivePaginationFailures += 1;
        console.error("Turnkey poll failed:", (error as Error).message);
      } finally {
        if (held) this.lifecycle.releaseLease(LEASE_NAME, this.owner);
        this.polling = undefined;
      }
    })();
    return this.polling;
  }

  private keyOf(activity: { organizationId: string; id: string }) { return `${activity.organizationId}\u0000${activity.id}`; }

  /** The durable name of an activity's charge and review, so a retry finds them instead of making new ones. */
  private activityKey(record: { organizationId: string; activityId: string }) { return `turnkey:${record.organizationId}:${record.activityId}`; }

  private async reconcile(handled: Set<string>): Promise<void> {
    for (const record of this.lifecycle.unresolved(RECONCILE_PER_POLL)) {
      // Least recently touched come first; touching each one moves it to the back, so records that are skipped or
      // cannot be read do not hold the front of the queue and every record is visited in turn.
      this.lifecycle.update(record.organizationId, record.activityId, {});
      // A review still waiting for a person needs nothing yet; the scan or a later pass picks it up.
      if (record.state === "REVIEW_OPEN" && record.reviewId && this.config.gate.reviewStatus(record.reviewId) === "PENDING") continue;
      // Backing off after a failure, or between checks of a pending vote: no call to Turnkey yet.
      if (!this.due(record)) { handled.add(this.keyOf({ organizationId: record.organizationId, id: record.activityId })); continue; }
      let activity: TurnkeyActivity;
      try { activity = await this.config.api.getActivity(record.activityId); }
      catch (error) {
        const wallet = this.config.wallets.get(record.wallet);
        if (wallet && this.watching(record) && this.pastHorizon(record)) { this.unresolved(record, wallet, "the signing activity could not be read"); continue; }
        const retries = record.retries + 1;
        this.lifecycle.update(record.organizationId, record.activityId, { retries, nextCheckAt: this.later(retries) });
        console.error(`Turnkey: could not re-read signing activity ${record.activityId}; it stays ${record.state}:`, (error as Error).message);
        continue;
      }
      if (!activity) continue;
      handled.add(this.keyOf({ organizationId: record.organizationId, id: record.activityId }));
      await this.handle(activity);
    }
  }

  private guardedWallet(activity: TurnkeyActivity): { address: string; wallet: GuardedWallet } | undefined {
    const intent = activity.intent ?? {};
    const addresses = [intent.signTransactionIntentV2?.signWith, intent.solSendTransactionIntent?.signWith, ...(intent.solSendTransactionIntentV2?.signWiths ?? [])];
    for (const address of addresses) {
      const wallet = address ? this.config.wallets.get(address) : undefined;
      if (wallet) return { address: address!, wallet };
    }
    return undefined;
  }

  /** Judges one activity, or moves its recorded lifecycle on. Public for tests; poll() is the normal caller. */
  async handle(activity: TurnkeyActivity): Promise<void> {
    const key = this.keyOf(activity);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      const record = this.lifecycle.get(activity.organizationId, activity.id);
      if (record) return await this.advance(record, activity);
      if (activity.status !== "ACTIVITY_STATUS_CONSENSUS_NEEDED") return;
      const guarded = this.guardedWallet(activity);
      if (!guarded) return;
      const { address, wallet } = guarded;
      const sign = activity.intent.signTransactionIntentV2;
      // Turnkey building or sending a transaction itself, or anything but a Solana signature, is not something
      // AgentGuard can read before it happens, so on a guarded wallet it is refused.
      if (activity.type !== "ACTIVITY_TYPE_SIGN_TRANSACTION_V2" || !sign || sign.type !== "TRANSACTION_TYPE_SOLANA") {
        return await this.rejectOnly(activity, address, wallet, `Activity type ${activity.type} is not a Solana signature AgentGuard can check.`, "UNSUPPORTED_ACTIVITY");
      }
      const transactionBase64 = this.transactionOf(activity);
      const transactionHash = transactionBase64 && this.config.gate.transactionHash(transactionBase64);
      if (!transactionBase64 || !transactionHash) return await this.rejectOnly(activity, address, wallet, "The unsigned transaction cannot be read.", "UNREADABLE_TRANSACTION");
      const claimed = this.lifecycle.claim({
        organizationId: activity.organizationId, activityId: activity.id, voteFingerprint: activity.fingerprint, wallet: address,
        customerId: wallet.customerId, agentId: wallet.agentId, policyId: wallet.policyId, transactionHash,
        policyFingerprint: this.config.gate.policyFingerprint(wallet)
      });
      if (!claimed) return;
      await this.check(this.lifecycle.get(activity.organizationId, activity.id)!, activity, wallet, transactionBase64);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * A request on a guarded wallet that AgentGuard can only refuse. It is recorded first, as REJECT_ONLY (no transaction
   * hash is invented), so the reject vote's request, its vote activity and its backoff survive polls and restarts.
   */
  private async rejectOnly(activity: TurnkeyActivity, address: string, wallet: GuardedWallet, reason: string, code: string): Promise<void> {
    const claimed = this.lifecycle.claim({
      organizationId: activity.organizationId, activityId: activity.id, voteFingerprint: activity.fingerprint, wallet: address,
      customerId: wallet.customerId, agentId: wallet.agentId, policyId: wallet.policyId, purpose: "REJECT_ONLY"
    });
    if (!claimed) return;
    await this.reject(this.lifecycle.get(activity.organizationId, activity.id)!, activity, wallet, reason, "REJECTED", code);
  }

  private transactionOf(activity: TurnkeyActivity): string | undefined {
    const hex = activity.intent?.signTransactionIntentV2?.unsignedTransaction;
    return hex && /^([0-9a-fA-F]{2})+$/.test(hex) ? Buffer.from(hex, "hex").toString("base64") : undefined;
  }

  /** First check of a claimed activity: ALLOW votes, anything else opens one review and records it. */
  private async check(record: ActivityRecord, activity: TurnkeyActivity, wallet: GuardedWallet, transactionBase64: string): Promise<void> {
    let outcome;
    try { outcome = await this.config.gate.evaluate(transactionBase64, wallet, this.activityKey(record)); }
    catch (error) { return await this.reject(record, activity, wallet, `The transaction could not be checked: ${(error as Error).message}`); }
    if (outcome.allowed) {
      return await this.approveVote({ ...record, policyFingerprint: outcome.policyFingerprint, reservation: outcome.reservation }, activity, wallet,
        { policyFingerprint: outcome.policyFingerprint, reservation: outcome.reservation ?? null });
    }
    this.lifecycle.update(record.organizationId, record.activityId, { state: "REVIEW_OPEN", reviewId: outcome.reviewId, policyFingerprint: outcome.policyFingerprint });
    this.config.gate.record(wallet, "turnkey_review_linked", { activityId: record.activityId, organizationId: record.organizationId, reviewId: outcome.reviewId, transactionHash: record.transactionHash, policyFingerprint: outcome.policyFingerprint });
  }

  /** Moves a recorded activity on, from what Turnkey now says about it. */
  private async advance(record: ActivityRecord, activity: TurnkeyActivity): Promise<void> {
    if (isTerminal(record.state)) return;
    const wallet = this.config.wallets.get(record.wallet);
    if (!wallet) return; // no longer guarded by this server: leave the activity and its record alone

    if (FINISHED.has(activity.status)) return this.finishedElsewhere(record, activity, wallet);
    if (activity.status !== "ACTIVITY_STATUS_CONSENSUS_NEEDED") return; // still being created on Turnkey's side
    if (!this.due(record)) return; // backing off: nothing is sent to Turnkey before nextCheckAt
    // AgentGuard's vote is finished (completed or refused): only read the signing activity, never vote on it again.
    if (record.state === "APPROVED" || record.state === "VOTE_REFUSED") return this.watchSigning(record, wallet);
    // A request AgentGuard can only refuse never reaches the checks, reviews, charges or approve votes below.
    if (record.purpose === "REJECT_ONLY") return await this.reject(record, activity, wallet, record.detail ?? "Rejected by AgentGuard.");

    // The same activity must still be the same request: same wallet, same bytes, same thing to vote on.
    const transactionBase64 = this.transactionOf(activity);
    const sameRequest = this.guardedWallet(activity)?.address === record.wallet && activity.fingerprint === record.voteFingerprint
      && transactionBase64 !== undefined && this.config.gate.transactionHash(transactionBase64) === record.transactionHash;
    if (!sameRequest) {
      return await this.reject(record, activity, wallet, "The activity no longer matches the transaction and wallet recorded for it.", "MISMATCH");
    }
    // And the wallet must still be assigned to the customer, agent and policy it was judged for. An approval or a
    // charge made for one assignment is never carried over to another: the request is rejected and must be made again.
    if (record.state !== "REJECT_PENDING" && !this.sameAssignment(record, wallet)) {
      // Before VOTING no approve vote has been submitted (VOTING is written before any is sent), so a charge held
      // for it goes back. After it, a vote may have counted, so the charge stays.
      if (record.state === "EVALUATING" || record.state === "REVIEW_OPEN") this.releaseHeld(record);
      return await this.reject(record, activity, wallet,
        `The wallet is now assigned to customer ${wallet.customerId ?? "(none)"}, agent ${wallet.agentId}, policy ${wallet.policyId}; the request was judged for customer ${record.customerId ?? "(none)"}, agent ${record.agentId}, policy ${record.policyId}.`,
        "MISMATCH", "ASSIGNMENT_CHANGED");
    }

    switch (record.state) {
      case "EVALUATING": {
        // The check was interrupted (a restart) before its result was recorded. If it allowed the transaction, its
        // charge is held under this activity's key: vote on it, unless the rules changed since the claim, in which
        // case refund it (no vote was submitted) and check again. Otherwise check again; a review it had opened is
        // found, not repeated.
        const held = this.config.gate.heldReservation(this.activityKey(record));
        if (held) {
          const current = this.config.gate.policyFingerprint(wallet);
          if (record.policyFingerprint !== undefined && current === record.policyFingerprint) {
            return await this.approveVote({ ...record, reservation: held }, activity, wallet, { reservation: held });
          }
          // No authorized policy now (the customer is missing or revoked, or the policy is gone): fail closed and
          // keep the held charge. A revocation must never trigger a refund; over-counting is the safe side.
          if (current === undefined) {
            return await this.reject({ ...record, reservation: held }, activity, wallet, "The wallet's customer or policy is no longer authorized.", "REJECTED", "TENANT_UNAUTHORIZED");
          }
          // A different but still-authorized policy revision: no vote was submitted, so the charge may go back and the transaction is checked again.
          this.config.gate.releaseBudget(held);
        }
        return await this.check(record, activity, wallet, transactionBase64);
      }
      case "REVIEW_OPEN": {
        // The wallet's customer must still be authorized to turn a human approval into a vote. If it is missing or
        // revoked, reject and keep any charge already made for it (a revocation never refunds): this stops both a
        // pending review being acted on and the recovery of an approval this activity consumed before a crash.
        if (this.config.gate.policyFingerprint(wallet) === undefined) {
          return await this.reject(record, activity, wallet, "The wallet's customer or policy is no longer authorized.", "REJECTED", "TENANT_UNAUTHORIZED");
        }
        const status = record.reviewId ? this.config.gate.reviewStatus(record.reviewId) : "MISSING";
        if (status === "PENDING") return;
        if (status !== "APPROVED") return await this.reject(record, activity, wallet, `The review ${record.reviewId} was ${status.toLowerCase()}.`);
        let spent: ReturnType<TurnkeyGate["consumeApproval"]> | ReturnType<TurnkeyGate["recoverApproval"]> =
          this.config.gate.consumeApproval(record.reviewId!, transactionBase64, wallet, this.activityKey(record));
        // Already spent: if this activity spent it and crashed before recording VOTING, carry on with it. That is
        // proved by the review store, not by a charge being held; no vote was sent, as VOTING is written before any vote.
        if (!spent.ok && spent.outcome === "already_used") spent = this.config.gate.recoverApproval(record.reviewId!, transactionBase64, wallet, this.activityKey(record));
        if (!spent.ok) {
          this.releaseHeld(record);
          return await this.reject(record, activity, wallet, `The approval could not be used (${spent.outcome}).`, "REJECTED", `APPROVAL_${spent.outcome.toUpperCase()}`);
        }
        return await this.approveVote({ ...record, reservation: spent.reservation }, activity, wallet, { reservation: spent.reservation });
      }
      case "VOTING":
      case "VOTE_PENDING":
      case "VOTE_UNKNOWN": {
        // An approve vote may already have been submitted. The signing activity still waits for consensus, so it has
        // not been signed yet. A submitted vote still being processed is reconciled read-only, whatever the tenant or
        // policy now say, so an earlier submission is always followed to its end.
        if (record.voteActivityId && !TERMINAL_STATUSES.has(record.voteActivityStatus ?? "")) return await this.queryVote(record, wallet);
        const current = this.config.gate.policyFingerprint(wallet);
        // A still-authorized tenant whose policy revision changed: reject (the approval was for other rules).
        if (current !== undefined && current !== record.policyFingerprint) {
          return await this.reject(record, activity, wallet, "The policy changed while the approve vote's outcome was unknown.");
        }
        // Unchanged, or no authorized policy (missing/revoked customer): approveVote authorizes a new or replayed
        // submission and otherwise only watches, never spending the approval or reserving the budget a second time.
        return await this.approveVote(record, activity, wallet);
      }
      case "REJECT_PENDING":
        return await this.reject(record, activity, wallet, record.detail ?? "Rejected by AgentGuard.");
    }
  }

  private sameAssignment(record: ActivityRecord, wallet: GuardedWallet): boolean {
    return (record.customerId ?? undefined) === (wallet.customerId ?? undefined) && record.agentId === wallet.agentId && record.policyId === wallet.policyId;
  }

  /** Refunds a charge held under this activity's key. Only for states before VOTING, when no approve vote has been submitted. */
  private releaseHeld(record: ActivityRecord): void {
    const held = this.config.gate.heldReservation(this.activityKey(record));
    if (held) this.config.gate.releaseBudget(held);
  }

  /**
   * Turnkey finished the signing activity. Record what it says; never give budget back on it. COMPLETED means it was
   * signed, by this vote or another approver's. REJECTED or FAILED is not documented to mean that no signature was
   * produced, so a charge held for it stays counted: this can overcount the day's spending, never undercount it.
   */
  private finishedElsewhere(record: ActivityRecord, activity: TurnkeyActivity, wallet: GuardedWallet): void {
    const state: LifecycleState = activity.status === "ACTIVITY_STATUS_COMPLETED" ? "SIGNING_COMPLETED"
      : activity.status === "ACTIVITY_STATUS_REJECTED" && record.state === "REJECT_PENDING" ? "REJECTED" : "RESOLVED_EXTERNALLY";
    const retained = record.reservation !== undefined;
    this.lifecycle.update(record.organizationId, record.activityId, {
      state, nextCheckAt: null, retries: 0,
      detail: `Turnkey reported ${activity.status} for the signing activity while AgentGuard had it as ${record.state}.${retained ? " ACCOUNTING_RETAINED: the charge stays counted." : ""}`
    });
    this.config.gate.record(wallet, "turnkey_resolved", {
      activityId: record.activityId, organizationId: record.organizationId, turnkeyStatus: activity.status, previousState: record.state, accountingRetained: retained,
      ...(record.voteActivityId ? { voteActivityId: record.voteActivityId } : {}), ...(record.reviewId ? { reviewId: record.reviewId } : {})
    });
  }

  /** Vote requests already sent for this activity. Records written before this was counted may have sent one. */
  private submissionsMade(record: ActivityRecord): number {
    const counted = record.voteKind === "APPROVE" ? record.voteSubmissions : 0;
    return counted === 0 && (record.state === "VOTING" || record.state === "VOTE_UNKNOWN" || record.state === "VOTE_PENDING") && !record.voteTimestampMs ? 1 : counted;
  }

  /** The recorded request of this kind may be sent again as it was: young enough, and its activity not finished without counting. */
  private replayable(record: ActivityRecord, kind: "APPROVE" | "REJECT"): string | undefined {
    if (record.voteKind !== kind || !record.voteTimestampMs) return undefined;
    if (record.voteActivityStatus && TERMINAL_STATUSES.has(record.voteActivityStatus) && record.voteActivityStatus !== VOTE_COMPLETED) return undefined;
    return this.nowMs() - Number(record.voteTimestampMs) < this.retry.replayWindowMs ? record.voteTimestampMs : undefined;
  }

  /** A timestampMs for a new request: never the recorded one, or Turnkey would answer with that same (failed) activity. */
  private newTimestamp(record: ActivityRecord): string {
    return String(Math.max(this.nowMs(), Number(record.voteTimestampMs ?? 0) + 1));
  }

  /**
   * Submits the approve vote, or replays the recorded one. The request (with its timestampMs) is written before it is
   * sent, together with `before` (the reservation, on the first vote), so a crash replays this exact request, which
   * Turnkey answers with the same vote activity, instead of creating a second vote.
   *
   * This is the single place an approve vote is submitted, so it is also where the wallet's tenant is authorized: a
   * missing or revoked customer (no authorized policy) stops any new or replayed approve submission. Submitting is
   * distinct from the read-only reconciliation of an already-submitted vote (queryVote, watchSigning), which runs
   * regardless of tenant state.
   */
  private async approveVote(record: ActivityRecord, activity: TurnkeyActivity, wallet: GuardedWallet, before: ActivityUpdate = {}): Promise<void> {
    const made = this.submissionsMade(record);
    let timestampMs = this.replayable(record, "APPROVE");
    const first = timestampMs === undefined && made === 0;
    const currentFingerprint = this.config.gate.policyFingerprint(wallet);
    if (currentFingerprint === undefined) {
      // No authorized policy for this wallet (its customer is missing or revoked, or the policy is gone). Record the
      // reservation if one was passed, then fail closed without submitting an approve vote and without refunding.
      if (Object.keys(before).length) this.lifecycle.update(record.organizationId, record.activityId, before);
      const detail = "TENANT_UNAUTHORIZED: the wallet's customer is missing or no longer active, or its policy is gone; no approve vote is submitted. ACCOUNTING_RETAINED.";
      // No approve request has gone out yet: reject the request. One may have: stop submitting and only watch.
      if (first) return await this.reject(record, activity, wallet, detail, "REJECTED", "TENANT_UNAUTHORIZED");
      return this.watchSigning(record, wallet, "VOTE_UNKNOWN", detail);
    }
    if (currentFingerprint !== record.policyFingerprint) {
      if (Object.keys(before).length) this.lifecycle.update(record.organizationId, record.activityId, before);
      const detail = "POLICY_CHANGED: the policy changed during evaluation; no approve vote is submitted. ACCOUNTING_RETAINED.";
      if (first) return await this.reject(record, activity, wallet, detail, "REJECTED", "POLICY_CHANGED");
      return this.watchSigning(record, wallet, "VOTE_UNKNOWN", detail);
    }
    if (timestampMs === undefined) {
      // Fencing: only the process that currently holds the poller lease may author a NEW distinct vote. A process
      // whose lease was taken over mid-pass (for example paused in an awaited check past the TTL while another replica
      // took over, even if that replica has since released) must not submit a second, differently-timestamped vote for
      // the same signing request, nor overwrite the active owner's record. The fence token detects the takeover; it is
      // not merely an expiry check, so a solo poller whose own lease simply lapsed with no takeover still proceeds. A
      // replay (an already-recorded timestamp, handled above) stays safe without this, being idempotent by timestamp.
      if (this.leaseFence !== undefined && !this.lifecycle.assertLease(LEASE_NAME, this.owner, this.leaseFence)) return;
      if (made >= this.retry.maxVoteSubmissions) {
        // No more new votes. The signing activity is still read (with backoff) until Turnkey finishes it or the horizon ends.
        if (Object.keys(before).length) this.lifecycle.update(record.organizationId, record.activityId, before);
        return this.watchSigning(record, wallet, "VOTE_UNKNOWN",
          `VOTE_ATTEMPTS_EXHAUSTED: ${made} approve vote requests sent without a completed vote; AgentGuard now only watches the signing activity. ACCOUNTING_RETAINED.`);
      }
      timestampMs = this.newTimestamp(record);
      this.lifecycle.update(record.organizationId, record.activityId, { ...before, state: "VOTING", voteKind: "APPROVE", voteTimestampMs: timestampMs, voteActivityId: null, voteActivityStatus: null, voteSubmissions: made + 1 });
    } else if (Object.keys(before).length) {
      this.lifecycle.update(record.organizationId, record.activityId, before);
    }
    const context = this.voteContext(record);
    let answer: VoteSubmission;
    try {
      answer = await this.config.api.approve(activity.fingerprint, timestampMs);
    } catch (error) {
      const status = error instanceof TurnkeyApiError ? error.status : undefined;
      // A 4xx (other than 408 timeout and 429 rate limit) refused this request. Only for the very first request is
      // that a statement that no AgentGuard vote exists; even then the signing activity may still complete through
      // another approver, so nothing is refunded and the spent approval is not returned.
      const refused = first && status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (refused) return await this.voteRefused(record, wallet, (error as Error).message, context);
      const retries = record.retries + 1;
      const code = status === 429 ? "VOTE_RATE_LIMITED" : "VOTE_OUTCOME_UNKNOWN";
      this.lifecycle.update(record.organizationId, record.activityId, { state: "VOTE_UNKNOWN", retries, nextCheckAt: this.later(retries), detail: `${code}: ${(error as Error).message}` });
      this.config.gate.record(wallet, "turnkey_failed", { ...context, outcome: "UNKNOWN", code, accountingRetained: true, message: (error as Error).message });
      return;
    }
    return this.voteAnswered(record, wallet, answer, context);
  }

  /** Asks Turnkey about the recorded, still-pending vote activity. Never submits anything. */
  private async queryVote(record: ActivityRecord, wallet: GuardedWallet): Promise<void> {
    let vote: { id?: string; status?: string };
    try {
      vote = await this.config.api.getActivity(record.voteActivityId!);
    } catch (error) {
      const retries = record.retries + 1;
      this.lifecycle.update(record.organizationId, record.activityId, { retries, nextCheckAt: this.later(retries), detail: `VOTE_STATUS_UNREADABLE: ${(error as Error).message}` });
      return;
    }
    return this.voteAnswered(record, wallet, { activityId: record.voteActivityId, ...(typeof vote?.status === "string" ? { status: vote.status } : {}) }, this.voteContext(record));
  }

  /** Records what Turnkey said about AgentGuard's approve vote activity. Only a COMPLETED vote activity is a recorded vote. */
  private voteAnswered(record: ActivityRecord, wallet: GuardedWallet, answer: VoteSubmission, context: Record<string, unknown>): void {
    const ids = { ...(answer.activityId ? { voteActivityId: answer.activityId } : {}), voteActivityStatus: answer.status ?? null };
    const voteContext = { ...context, ...(answer.activityId ? { voteActivityId: answer.activityId } : {}), voteStatus: answer.status ?? null };
    if (answer.status === VOTE_COMPLETED) {
      // The vote is finished; the signing activity may still need other approvers, so it is watched from now on.
      this.lifecycle.update(record.organizationId, record.activityId, { ...ids, state: "APPROVED", retries: 0, nextCheckAt: null, watchSince: new Date(this.nowMs()).toISOString(),
        detail: "AgentGuard's approve vote activity completed; the signing activity is watched until Turnkey finishes it." });
      this.config.gate.record(wallet, "turnkey_approved", voteContext);
      return;
    }
    const retries = record.retries + 1;
    if (answer.status && TERMINAL_STATUSES.has(answer.status)) {
      // The vote activity finished without completing: this vote was not recorded. A new one may be sent later (bounded).
      this.lifecycle.update(record.organizationId, record.activityId, { ...ids, state: "VOTE_UNKNOWN", retries, nextCheckAt: this.later(retries),
        detail: `VOTE_NOT_COMPLETED: AgentGuard's vote activity ended ${answer.status}. ACCOUNTING_RETAINED.` });
      this.config.gate.record(wallet, "turnkey_failed", { ...voteContext, outcome: "UNKNOWN", code: "VOTE_NOT_COMPLETED", accountingRetained: true });
      return;
    }
    if (answer.activityId) {
      // Processing, or a status AgentGuard does not know: ask about this vote activity again later, without a new vote.
      this.lifecycle.update(record.organizationId, record.activityId, { ...ids, state: "VOTE_PENDING", retries, nextCheckAt: this.later(retries),
        detail: `VOTE_PENDING: AgentGuard's vote activity is ${answer.status ?? "without a status"}.` });
      return;
    }
    // No vote activity id: the answer was missing or malformed. The recorded request is replayed later, which Turnkey
    // answers with the same activity, until the replay window ends; then new requests, up to maxVoteSubmissions.
    this.lifecycle.update(record.organizationId, record.activityId, { ...ids, state: "VOTE_UNKNOWN", retries, nextCheckAt: this.later(retries),
      detail: "VOTE_NO_ACTIVITY_ID: Turnkey's answer named no vote activity. ACCOUNTING_RETAINED." });
    this.config.gate.record(wallet, "turnkey_failed", { ...voteContext, outcome: "UNKNOWN", code: "VOTE_NO_ACTIVITY_ID", accountingRetained: true });
  }

  /**
   * Turnkey refused AgentGuard's first approve request outright. The charge and the spent approval are kept: the
   * signing activity may still complete through another approver. Read it once now so the record says what is known.
   */
  private async voteRefused(record: ActivityRecord, wallet: GuardedWallet, message: string, context: Record<string, unknown>): Promise<void> {
    this.lifecycle.update(record.organizationId, record.activityId, { state: "VOTE_REFUSED", nextCheckAt: null, retries: 0, watchSince: new Date(this.nowMs()).toISOString(),
      detail: `VOTE_REFUSED: ${message} ACCOUNTING_RETAINED.` });
    this.config.gate.record(wallet, "turnkey_failed", { ...context, outcome: "REFUSED", accountingRetained: true, message });
    try {
      const signing = await this.config.api.getActivity(record.activityId);
      if (signing?.status === "ACTIVITY_STATUS_COMPLETED") {
        this.lifecycle.update(record.organizationId, record.activityId, { state: "SIGNING_COMPLETED",
          detail: `Turnkey refused AgentGuard's vote (${message}), but reports the signing activity completed. ACCOUNTING_RETAINED: the charge stays counted.` });
        this.config.gate.record(wallet, "turnkey_resolved", { ...context, turnkeyStatus: signing.status, previousState: "VOTE_REFUSED", accountingRetained: true });
      }
    } catch { /* unreadable now: the record stays VOTE_REFUSED and the signing activity is read again on later passes */ }
  }

  /** States in which AgentGuard no longer votes and only reads the signing activity. */
  private watching(record: ActivityRecord): boolean {
    return record.state === "APPROVED" || record.state === "VOTE_REFUSED" || record.watchSince !== undefined;
  }

  /** Records from before watchSince existed count from their creation, so old ones end their observation quickly. */
  private pastHorizon(record: ActivityRecord): boolean {
    return this.nowMs() - Date.parse(record.watchSince ?? record.createdAt) >= this.retry.watchHorizonMs;
  }

  /**
   * Read-only follow-up of a signing activity Turnkey has not finished (it was just read as still waiting): schedule the
   * next read with backoff, or, past the observation horizon, hand the record to an operator as SIGNING_UNRESOLVED.
   * `state`/`detail` set the record when watching starts here (vote or reject requests exhausted).
   */
  private watchSigning(record: ActivityRecord, wallet: GuardedWallet, state?: LifecycleState, detail?: string): void {
    // Watching that starts here has just begun. Otherwise count from watchSince, or, for a legacy APPROVED or
    // VOTE_REFUSED record without one, from its creation.
    const startsNow = record.watchSince === undefined && state !== undefined;
    if (!startsNow && this.pastHorizon(record)) return this.unresolved(record, wallet, "Turnkey had not finished the signing activity");
    const watchSince = record.watchSince ?? (startsNow ? new Date(this.nowMs()).toISOString() : record.createdAt);
    const retries = record.retries + 1;
    this.lifecycle.update(record.organizationId, record.activityId, {
      ...(state ? { state } : {}), ...(detail ? { detail } : {}), ...(record.watchSince ? {} : { watchSince }), retries, nextCheckAt: this.later(retries)
    });
  }

  /** The observation horizon ended without a final status from Turnkey. The charge stays; an operator decides. */
  private unresolved(record: ActivityRecord, wallet: GuardedWallet, why: string): void {
    const days = Math.round(this.retry.watchHorizonMs / 86_400_000);
    this.lifecycle.update(record.organizationId, record.activityId, { state: "SIGNING_UNRESOLVED", nextCheckAt: null,
      detail: `OBSERVATION_ENDED: ${why} after ${days} day(s) of observation (previous state ${record.state}). Check the request in Turnkey.${record.reservation ? " ACCOUNTING_RETAINED." : ""}` });
    this.config.gate.record(wallet, "turnkey_resolved", { activityId: record.activityId, organizationId: record.organizationId, previousState: record.state, unresolved: true, accountingRetained: record.reservation !== undefined });
  }

  private voteContext(record: ActivityRecord): Record<string, unknown> {
    return { activityId: record.activityId, organizationId: record.organizationId, policyFingerprint: record.policyFingerprint, ...(record.reviewId ? { viaReview: record.reviewId } : {}) };
  }

  /**
   * Sends the reject vote, replaying the recorded reject request if there is one, or asks about a pending reject vote
   * activity. Until a reject vote activity completes the record stays REJECT_PENDING and is retried with backoff.
   */
  private async reject(record: ActivityRecord, activity: TurnkeyActivity, wallet: GuardedWallet, reason: string, finalState: "REJECTED" | "MISMATCH" = "REJECTED", code?: string): Promise<void> {
    const context = { activityId: activity.id, organizationId: activity.organizationId, reason, ...(code ? { code } : {}), ...(record.reviewId ? { reviewId: record.reviewId } : {}) };
    // The code is kept at the front of the detail, so a retried reject and the record both still carry it.
    if (code) reason = `${code}: ${reason}`;
    let answer: VoteSubmission;
    try {
      if (record.voteKind === "REJECT" && record.voteActivityId && !TERMINAL_STATUSES.has(record.voteActivityStatus ?? "")) {
        const vote = await this.config.api.getActivity(record.voteActivityId);
        answer = { activityId: record.voteActivityId, ...(typeof vote?.status === "string" ? { status: vote.status } : {}) };
      } else {
        const replay = this.replayable(record, "REJECT");
        if (!replay) {
          const made = record.voteKind === "REJECT" ? record.voteSubmissions : 0;
          if (made >= this.retry.maxVoteSubmissions) {
            // No more reject requests. The signing activity still cannot complete without AgentGuard's approval; it is
            // read (with backoff) until Turnkey finishes it or the horizon ends.
            return this.watchSigning(record, wallet, "REJECT_PENDING", `REJECT_ATTEMPTS_EXHAUSTED: ${made} reject requests sent without a completed reject. ${reason}`);
          }
        }
        const timestampMs = replay ?? this.newTimestamp(record);
        if (!replay) this.lifecycle.update(record.organizationId, record.activityId, { state: "REJECT_PENDING", detail: reason, voteKind: "REJECT", voteTimestampMs: timestampMs, voteActivityId: null, voteActivityStatus: null,
          voteSubmissions: (record.voteKind === "REJECT" ? record.voteSubmissions : 0) + 1 });
        answer = await this.config.api.reject(activity.fingerprint, timestampMs);
      }
    } catch (error) {
      const retries = record.retries + 1;
      this.lifecycle.update(record.organizationId, record.activityId, { state: "REJECT_PENDING", detail: reason, retries, nextCheckAt: this.later(retries) });
      this.config.gate.record(wallet, "turnkey_failed", { ...context, outcome: "REJECT_FAILED", message: (error as Error).message });
      return;
    }
    if (answer.status !== VOTE_COMPLETED) {
      // Not a recorded reject yet: pending (asked about later), or finished without completing (sent again later).
      const retries = record.retries + 1;
      this.lifecycle.update(record.organizationId, record.activityId, { state: "REJECT_PENDING", detail: reason, retries, nextCheckAt: this.later(retries),
        ...(answer.activityId ? { voteActivityId: answer.activityId } : {}), voteActivityStatus: answer.status ?? null });
      this.config.gate.record(wallet, "turnkey_failed", { ...context, outcome: "REJECT_FAILED", code: "VOTE_NOT_COMPLETED", voteStatus: answer.status ?? null, ...(answer.activityId ? { voteActivityId: answer.activityId } : {}) });
      return;
    }
    // A reservation held here is kept: an approve vote may already have counted.
    this.lifecycle.update(record.organizationId, record.activityId, { state: finalState, detail: reason, retries: 0, nextCheckAt: null, ...(answer.activityId ? { voteActivityId: answer.activityId } : {}), voteActivityStatus: answer.status });
    this.config.gate.record(wallet, "turnkey_rejected", { ...context, ...(answer.activityId ? { voteActivityId: answer.activityId } : {}) });
  }
}
