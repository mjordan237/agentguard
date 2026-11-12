import { Router, urlencoded, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import type { PendingReview, PendingReviewStore, ResolutionActor, ReviewListQuery, ReviewScope, ReviewStatus } from "./pending-store.js";
import type { ReviewerStore } from "./reviewer-store.js";
import type { ActivityRecord } from "../turnkey/lifecycle-store.js";
import type { AuditEvent } from "../observability/audit-log.js";
import { queueItem, reviewDetail } from "./review-view.js";
import { APP_PAGE_CSP, APP_SHELL_HTML, APP_SCRIPT } from "./operator-queue-page.js";

/** Read-only records about a review kept by other stores. Supplied by the server; absent in unit tests of the router. */
export interface ReviewContextSource {
  /** The Turnkey activity each review was opened for, in one query. */
  activitiesFor(reviewIds: readonly string[]): Map<string, ActivityRecord>;
  /** The newest direct-signing outcome that spent this review's approval, and the newest refused attempt to spend it. */
  auditFor(review: PendingReview): { signing?: AuditEvent; refusal?: AuditEvent };
  /** The reviewed policy's revision as it stands now; undefined when it cannot be told. */
  currentPolicyFingerprint(review: PendingReview): string | undefined;
}

export interface ReviewRouterOptions {
  /** Legacy shared secret. Resolutions made with it are attributed to "shared-secret", not to a person. */
  actionSecret?: string;
  /** Named reviewers with personal tokens. When any active reviewer exists, their tokens are accepted. */
  reviewers?: ReviewerStore;
  /** When true, the shared secret is ignored and only reviewer tokens can approve or deny. */
  requireReviewers?: boolean;
  /** Called once, only when this request is the one that approved or denied a pending review. */
  onResolved?: (review: PendingReview) => void;
  context?: ReviewContextSource;
}

function toJsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, val) => (typeof val === "bigint" ? val.toString() : val));
}

/** Reviewer tokens and the legacy secret share the same transport: a header, or a form field. */
function credentialFromRequest(req: Request): string | undefined {
  const headerValue = req.get("x-reviewer-token") ?? req.get("x-review-action-secret");
  if (headerValue) return headerValue;
  if (typeof req.body?.token === "string") return req.body.token;
  return typeof req.body?.secret === "string" ? req.body.secret : undefined;
}

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

const STATUSES: readonly ReviewStatus[] = ["PENDING", "APPROVED", "DENIED", "EXPIRED"];
const DEFAULT_PAGE = 25;
const MAX_PAGE = 100;
const QUERY_KEYS = new Set(["status", "agent", "chain", "limit", "cursor"]);

/** Cursor: the last review of a page, base64url JSON. Opaque to callers, checked strictly when it comes back. */
const encodeCursor = (review: PendingReview) => Buffer.from(JSON.stringify({ c: review.createdAt, i: review.id })).toString("base64url");
function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof value.c !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.c)) return undefined;
    if (typeof value.i !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(value.i)) return undefined;
    return { createdAt: value.c, id: value.i };
  } catch { return undefined; }
}

/** Validates the queue's query string. Unknown or repeated parameters are refused rather than ignored. */
function parseListQuery(query: Request["query"], scope: ReviewScope): ReviewListQuery | string {
  for (const key of Object.keys(query)) if (!QUERY_KEYS.has(key)) return `Unknown parameter "${key}".`;
  for (const [key, value] of Object.entries(query)) if (typeof value !== "string") return `Give ${key} once, as a single value.`;
  const q = query as Record<string, string | undefined>;
  // A queue answers "what needs attention" unless asked otherwise: PENDING by default, ALL for every status.
  const status = q.status === undefined ? "PENDING" : q.status === "ALL" ? undefined : STATUSES.find((s) => s === q.status);
  if (q.status !== undefined && q.status !== "ALL" && !status) return "status must be PENDING, APPROVED, DENIED, EXPIRED or ALL.";
  if (q.agent !== undefined && (q.agent.length === 0 || q.agent.length > 200 || /[\u0000-\u001f\u007f]/.test(q.agent))) return "agent must be 1 to 200 printable characters.";
  if (q.chain !== undefined && !/^(solana|evm|evm:\d{1,12}|unknown)$/.test(q.chain)) return "chain must be solana, evm, evm:<chain id> or unknown.";
  if (q.limit !== undefined && !(/^\d{1,3}$/.test(q.limit) && Number(q.limit) >= 1 && Number(q.limit) <= MAX_PAGE)) return `limit must be a whole number from 1 to ${MAX_PAGE}.`;
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
  if (q.cursor !== undefined && !after) return "cursor is not one this server issued. Start again from the first page.";
  return { scope, status, agentId: q.agent, chain: q.chain, limit: q.limit === undefined ? DEFAULT_PAGE : Number(q.limit), after };
}

export function createReviewRouter(store: PendingReviewStore, options: ReviewRouterOptions = {}): Router {
  const router = Router();
  const sharedSecretAllowed = () => Boolean(options.actionSecret) && !options.requireReviewers;
  const reviewerLoginAvailable = () => Boolean(options.reviewers?.hasActiveReviewers());
  const actionsEnabled = () => reviewerLoginAvailable() || sharedSecretAllowed();

  /**
   * Returns who is acting, or undefined if the credential matches nobody. `customerId` is set for a
   * customer's own reviewer, who may act only on that customer's reviews; operator reviewers and the
   * shared secret have no scope and may act on any review.
   */
  function authenticate(req: Request): { actor: ResolutionActor; customerId?: string } | undefined {
    const credential = credentialFromRequest(req);
    if (!credential) return undefined;
    const reviewer = options.reviewers?.authenticate(credential);
    if (reviewer) return { actor: { kind: "reviewer", id: reviewer.id, name: reviewer.name }, customerId: reviewer.customerId };
    if (sharedSecretAllowed() && secretMatches(credential, options.actionSecret!)) return { actor: { kind: "shared-secret" } };
    return undefined;
  }

  router.use(urlencoded({ extended: false }));

  // The review pages and the queue are one static shell and one same-origin script. The shell holds no review data:
  // it is the same bytes for every review id, real or not, and the script loads the review only after the reviewer
  // signs in (see operator-queue-page.ts). Never framed, never leaked in a Referer, never cached.
  const pageHeaders = (_req: Request, res: Response, next: () => void) => {
    res.set({ "Content-Security-Policy": APP_PAGE_CSP, "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
    next();
  };
  router.use("/review", pageHeaders);
  router.use("/operator", pageHeaders);
  router.get("/operator/reviews", (_req, res) => res.type("html").send(APP_SHELL_HTML));
  router.get("/review/:id", (_req, res) => res.type("html").send(APP_SHELL_HTML));
  router.get("/operator/app.js", (_req, res) => res.type("text/javascript").send(APP_SCRIPT));

  /**
   * The queue API's caller: a customer's reviewer sees only that customer's reviews; an operator reviewer, or the
   * shared secret where it is still accepted, sees all. The credential comes in a header only, never the URL.
   */
  function queueCaller(req: Request, res: Response): ReviewScope | undefined {
    if (!actionsEnabled()) {
      res.status(503).json({ error: "REVIEWS_DISABLED", message: "Reviews are switched off: no reviewer is registered and no shared secret is enabled." });
      return undefined;
    }
    const credential = req.get("x-reviewer-token") ?? req.get("x-review-action-secret");
    const caller = credential ? authenticate(req) : undefined;
    if (!caller) {
      res.status(401).json({ error: "INVALID_REVIEWER_TOKEN", message: "Send a valid reviewer token in the X-Reviewer-Token header." });
      return undefined;
    }
    return caller.customerId !== undefined ? { customerId: caller.customerId } : "all";
  }

  router.get("/operator/api/reviews", (req, res) => {
    const scope = queueCaller(req, res);
    if (!scope) return;
    const query = parseListQuery(req.query, scope);
    if (typeof query === "string") return res.status(400).json({ error: "INVALID_REQUEST", message: query });
    const page = store.list(query);
    const activities = options.context?.activitiesFor(page.reviews.map((review) => review.id)) ?? new Map<string, ActivityRecord>();
    return res.status(200).type("application/json").send(toJsonSafe({
      scope: scope === "all" ? "all" : "customer",
      limit: query.limit,
      items: page.reviews.map((review) => queueItem(review, activities.get(review.id), scope === "all")),
      nextCursor: page.more ? encodeCursor(page.reviews.at(-1)!) : null
    }));
  });

  router.get("/operator/api/reviews/:id", (req, res) => {
    const scope = queueCaller(req, res);
    if (!scope) return;
    const review = store.get(req.params.id);
    // Another customer's review answers exactly as a missing one does.
    if (!review || (scope !== "all" && review.customerId !== scope.customerId)) return res.status(404).json({ error: "REVIEW_NOT_FOUND", message: "No review with this id is visible to you." });
    const audit = options.context?.auditFor(review) ?? {};
    const records = {
      activity: options.context?.activitiesFor([review.id]).get(review.id),
      signing: audit.signing,
      refusal: audit.refusal,
      currentPolicyFingerprint: options.context?.currentPolicyFingerprint(review)
    };
    return res.status(200).type("application/json").send(toJsonSafe(reviewDetail(review, records, { operator: scope === "all" })));
  });

  function resolveReview(status: "APPROVED" | "DENIED") {
    return (req: Request, res: Response) => {
      if (!actionsEnabled()) {
        return res.status(503).send("Review actions are disabled because no reviewer is registered and no shared secret is enabled.");
      }
      const caller = authenticate(req);
      if (!caller) {
        return res.status(401).send("A valid reviewer token is required.");
      }
      // A customer's reviewer gets the same answer for another customer's review as for a missing one.
      if (caller.customerId !== undefined && store.get(req.params.id)?.customerId !== caller.customerId) {
        return res.status(404).send("Review not found.");
      }

      // Whether this request made the decision comes from the transition itself, not from a read before or after
      // it: only that request records the resolution and triggers its side effects.
      const { outcome, review } = store.resolveOutcome(req.params.id, status, caller.actor);
      if (outcome === "not_found" || !review) return res.status(404).send("Review not found.");
      if (outcome === "applied") options.onResolved?.(review);
      // The review page asks for JSON so it can say truthfully what this request did. Everyone else (form posts,
      // scripts) keeps the original answers: a redirect to the review, or 410 once it has expired.
      if (req.accepts(["html", "json"]) === "json") {
        const code = outcome === "applied" ? 200 : outcome === "expired" ? 410 : 409;
        return res.status(code).json({ id: review.id, requested: status, outcome, status: review.status });
      }
      if (outcome === "expired") return res.status(410).send("Review expired and can no longer be acted on.");
      res.redirect(`/review/${review.id}`);
    };
  }

  router.post("/review/:id/approve", resolveReview("APPROVED"));
  router.post("/review/:id/deny", resolveReview("DENIED"));
  return router;
}
