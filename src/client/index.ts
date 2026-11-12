/**
 * A small client for the AgentGuard HTTP API. No dependencies beyond the platform `fetch` (Node 18+).
 *
 * It never retries on its own. A signing request that fails with an unknown outcome may already have been
 * broadcast, so retrying is the caller's decision after checking the chain; `AgentGuardError.outcomeUnknown`
 * says when that applies.
 */

export type Decision = "ALLOW" | "NEEDS_REVIEW";
export type ReviewState = "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";

export interface Evaluation {
  decision: Decision;
  reasons: string[];
  logEntryId?: string;
  /** Present when decision is NEEDS_REVIEW: a person has been asked. */
  reviewId?: string;
  reviewUrl?: string;
  [key: string]: unknown;
}

/** Result of /gate-and-sign when the transaction was signed and submitted through Kora. */
export interface SignedResult extends Evaluation {
  kora?: Record<string, unknown>;
  /** The review whose approval was spent on this signature, if any. */
  signedViaReview?: string;
}

export interface ReviewStatus {
  id: string;
  status: ReviewState;
  reasons: string[];
  createdAt?: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /** True once an approval has been spent on a signature. */
  used: boolean;
}

export interface TransactionRequest {
  agentId: string;
  policyId: string;
  transactionBase64: string;
}

export interface AgentGuardClientOptions {
  /** For example https://agentguard.example.com (no trailing path). */
  baseUrl: string;
  /** Customer API key (agk_...). Sent only in the Authorization header. */
  apiKey?: string;
  /** Per-request timeout. Default 15 seconds. */
  timeoutMs?: number;
  /** For tests or custom transports. */
  fetchImpl?: typeof fetch;
}

export class AgentGuardError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The server's `error` code, for example INVALID_REQUEST, REVIEW_NOT_APPROVED or KORA_SIGNING_FAILED. */
    readonly code: string | undefined,
    readonly body: unknown,
    /** True when the server says the transaction may or may not have been sent. Check the chain before retrying. */
    readonly outcomeUnknown: boolean
  ) {
    super(message);
    this.name = "AgentGuardError";
  }
}

export type WaitOptions = {
  /** Give up after this long. Default 10 minutes. */
  timeoutMs?: number;
  /** Time between checks. Default 2 seconds, never below 250 ms. */
  pollMs?: number;
  signal?: AbortSignal;
};

export type SignWithApprovalOutcome =
  | { outcome: "signed"; result: SignedResult; reviewed: boolean }
  | { outcome: "denied" | "expired"; review: ReviewStatus }
  /** Nobody resolved the review in time. It is still pending; check `reviewUrl` or call again with the reviewId. */
  | { outcome: "timeout"; reviewId: string; reviewUrl?: string };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error("Aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class AgentGuardClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentGuardClientOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new Error("baseUrl must be a valid URL such as https://agentguard.example.com"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("baseUrl must be http or https.");
    this.baseUrl = url.origin + url.pathname.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
    if (!response.ok) {
      const object = (parsed !== null && typeof parsed === "object" ? parsed : {}) as { error?: unknown; message?: unknown; outcome?: unknown };
      const code = typeof object.error === "string" ? object.error : undefined;
      const message = typeof object.message === "string" ? object.message : `AgentGuard answered HTTP ${response.status}${code ? ` (${code})` : ""}.`;
      throw new AgentGuardError(message, response.status, code, parsed, object.outcome === "UNKNOWN");
    }
    if (parsed === undefined) throw new AgentGuardError("AgentGuard sent a reply that is not JSON.", response.status, undefined, text, false);
    return parsed as T;
  }

  /** Decide only. Spends nothing unless `reserve` is true (use that when you sign somewhere other than AgentGuard). */
  evaluate(request: TransactionRequest & { reserve?: boolean }): Promise<Evaluation> {
    return this.request("POST", "/evaluate", request);
  }

  /**
   * Evaluate, and if the transaction is ALLOWed (or `reviewId` names an approved review of this exact transaction),
   * sign and submit it through Kora. A NEEDS_REVIEW answer is returned, not thrown: it carries `reviewId` and `reviewUrl`.
   */
  gateAndSign(request: TransactionRequest & { reviewId?: string }): Promise<SignedResult> {
    return this.request("POST", "/gate-and-sign", request);
  }

  getReview(reviewId: string): Promise<ReviewStatus> {
    return this.request("GET", `/reviews/${encodeURIComponent(reviewId)}`);
  }

  /** Polls until the review is APPROVED, DENIED or EXPIRED. Returns undefined on timeout. */
  async waitForReview(reviewId: string, options: WaitOptions = {}): Promise<ReviewStatus | undefined> {
    const deadline = Date.now() + (options.timeoutMs ?? 600_000);
    const poll = Math.max(250, options.pollMs ?? 2_000);
    for (;;) {
      const review = await this.getReview(reviewId);
      if (review.status !== "PENDING") return review;
      if (Date.now() + poll > deadline) return undefined;
      await sleep(poll, options.signal);
    }
  }

  /**
   * The whole loop an agent needs: try to sign; if a person must decide, wait for them; if they approve, sign the same
   * transaction with that approval. Nothing is retried after a failure and nothing waits forever.
   */
  async signWithApproval(request: TransactionRequest, wait: WaitOptions = {}): Promise<SignWithApprovalOutcome> {
    const first = await this.gateAndSign(request);
    if (first.decision === "ALLOW") return { outcome: "signed", result: first, reviewed: false };
    if (!first.reviewId) throw new AgentGuardError("The transaction needs review but the server returned no reviewId.", 200, undefined, first, false);

    const review = await this.waitForReview(first.reviewId, wait);
    if (!review) return { outcome: "timeout", reviewId: first.reviewId, reviewUrl: first.reviewUrl };
    if (review.status === "DENIED" || review.status === "EXPIRED") return { outcome: review.status === "DENIED" ? "denied" : "expired", review };
    const second = await this.gateAndSign({ ...request, reviewId: first.reviewId });
    return { outcome: "signed", result: second, reviewed: true };
  }
}
