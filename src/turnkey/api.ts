import { ApiKeyStamper } from "./stamp.js";

/** The parts of a Turnkey activity the approver reads. Everything else in Turnkey's response is ignored. */
export interface TurnkeyActivity {
  id: string;
  organizationId: string;
  status: string;
  type: string;
  fingerprint: string;
  intent: {
    signTransactionIntentV2?: { signWith: string; unsignedTransaction: string; type: string };
    solSendTransactionIntent?: { signWith?: string; unsignedTransaction?: string };
    solSendTransactionIntentV2?: { signWiths?: string[]; unsignedTransaction?: string };
  };
}

export class TurnkeyApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "TurnkeyApiError";
  }
}

/**
 * One bounded pass over the waiting activities. `complete` is true only when the pass reached the end of the list;
 * otherwise it stopped at the page cap, on a repeated page, or on an error, and the next pass carries on.
 */
export interface ActivityScan {
  activities: TurnkeyActivity[];
  complete: boolean;
  pages: number;
  /** The cursor this pass started from; undefined when it started at the top of the list. */
  startedAfter?: string;
  error?: string;
}

/** The calls the approver makes: read waiting activities, then approve or reject one. */
export interface TurnkeyApi {
  scanWaitingActivities(): Promise<ActivityScan>;
  /** The activities of one scan, for callers that do not need to know whether it was complete. */
  listWaitingActivities(): Promise<TurnkeyActivity[]>;
  getActivity(activityId: string): Promise<TurnkeyActivity>;
  /**
   * Submits a vote on the signing activity with this fingerprint. A vote is itself an activity (the "vote activity"),
   * separate from the signing activity. The request body is fixed by `timestampMs`: Turnkey returns the same activity
   * for an identical body, and a new timestampMs creates a new one (docs.turnkey.com/api-reference/activities/overview,
   * docs.turnkey.com/reference/rate-limits). Only ACTIVITY_STATUS_COMPLETED means the vote was recorded; an HTTP
   * success can carry FAILED or PENDING. Query a pending vote activity with getActivity(activityId).
   */
  approve(fingerprint: string, timestampMs: string): Promise<VoteSubmission>;
  reject(fingerprint: string, timestampMs: string): Promise<VoteSubmission>;
}

/** What Turnkey answered to a vote: the vote activity's id and status, each absent if the answer did not give it. */
export interface VoteSubmission {
  activityId?: string;
  status?: string;
}

/** The only vote-activity status that shows a vote was recorded. */
export const VOTE_COMPLETED = "ACTIVITY_STATUS_COMPLETED";
/** Activity statuses after which nothing more happens to that activity (the official SDK's TERMINAL_ACTIVITY_STATUSES). */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["ACTIVITY_STATUS_COMPLETED", "ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"]);

export interface TurnkeyApiConfig {
  organizationId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

/** Activity types the approver looks at: the ones that sign or send a Solana transaction. */
export const WATCHED_ACTIVITY_TYPES = ["ACTIVITY_TYPE_SIGN_TRANSACTION_V2", "ACTIVITY_TYPE_SOL_SEND_TRANSACTION", "ACTIVITY_TYPE_SOL_SEND_TRANSACTION_V2"];

/** Turnkey's HTTP API, every request stamped with AgentGuard's own API key. */
export function turnkeyHttpApi(config: TurnkeyApiConfig): TurnkeyApi {
  const stamper = new ApiKeyStamper(config.apiPublicKey, config.apiPrivateKey);
  const baseUrl = (config.baseUrl ?? "https://api.turnkey.com").replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;
  const call = async (path: string, payload: Record<string, unknown>) => {
    const body = JSON.stringify(payload);
    const response = await doFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Stamp": stamper.stamp(body) },
      body,
      signal: AbortSignal.timeout(config.timeoutMs ?? 10_000)
    });
    const text = await response.text();
    if (!response.ok) throw new TurnkeyApiError(`Turnkey ${path} answered ${response.status}: ${text.slice(0, 300)}`, response.status);
    try { return JSON.parse(text) as Record<string, unknown>; }
    catch { throw new TurnkeyApiError(`Turnkey ${path} answered ${response.status} with a body that is not JSON.`, response.status); }
  };
  const vote = (kind: "APPROVE" | "REJECT") => async (fingerprint: string, timestampMs: string): Promise<VoteSubmission> => {
    const result = await call(`/public/v1/submit/${kind.toLowerCase()}_activity`, {
      type: `ACTIVITY_TYPE_${kind}_ACTIVITY`, timestampMs, organizationId: config.organizationId, parameters: { fingerprint }
    });
    const activity = result.activity as { id?: unknown; status?: unknown } | undefined;
    return {
      ...(typeof activity?.id === "string" && activity.id ? { activityId: activity.id } : {}),
      ...(typeof activity?.status === "string" && activity.status ? { status: activity.status } : {})
    };
  };
  // Pagination state carried between scans: where the next one starts, and how often a scan from there has failed.
  let resumeAfter: string | undefined;
  let failuresAtCursor = 0;
  const scanWaitingActivities = async (): Promise<ActivityScan> => {
    // Turnkey documents `limit` (1 to 100, default 10) and `after` (an activity id), but not the order, the end of
    // the list, or whether a short page is the last, so only an empty page ends a scan. Other wallets' requests share
    // the pages, since the filter is by status and type. Each scan reads MAX_PAGES at most and the next one carries
    // on from there, wrapping to the start after the end, so every waiting activity is reached within a few scans.
    const seen = new Map<string, TurnkeyActivity>();
    const startedAfter = resumeAfter;
    let after = resumeAfter;
    for (let page = 0; page < MAX_PAGES; page++) {
      let activities: TurnkeyActivity[];
      try {
        const result = await call("/public/v1/query/list_activities", {
          organizationId: config.organizationId, filterByStatus: ["ACTIVITY_STATUS_CONSENSUS_NEEDED"], filterByType: WATCHED_ACTIVITY_TYPES,
          paginationOptions: { limit: String(PAGE_SIZE), ...(after ? { after } : {}) }
        });
        activities = (result.activities ?? []) as TurnkeyActivity[];
      } catch (error) {
        // Keep the progress made: the next scan retries from the same place. If that place fails twice running,
        // its activity may have gone (Turnkey does not say what `after` does then), so start again from the top.
        failuresAtCursor = after === undefined ? 0 : failuresAtCursor + 1;
        if (failuresAtCursor >= 2) { resumeAfter = undefined; failuresAtCursor = 0; } else resumeAfter = after;
        return { activities: [...seen.values()], complete: false, pages: page, startedAfter, error: (error as Error).message };
      }
      failuresAtCursor = 0;
      if (activities.length === 0) { resumeAfter = undefined; return { activities: [...seen.values()], complete: true, pages: page + 1, startedAfter }; }
      const fresh = activities.filter((activity) => !seen.has(activity.id));
      for (const activity of fresh) seen.set(activity.id, activity);
      if (fresh.length === 0) {
        resumeAfter = undefined;
        // Nothing new, ending at the cursor: nothing lies after it, so this is the end of the list (pages that
        // overlap end this way). Nothing new anywhere else: the cursor is not moving. Either way stop rather than
        // loop; only the first counts as a complete scan. The next scan starts from the top.
        const atEnd = after !== undefined && activities[activities.length - 1]!.id === after;
        return { activities: [...seen.values()], complete: atEnd, pages: page + 1, startedAfter, ...(atEnd ? {} : { error: "A page repeated earlier results." }) };
      }
      after = activities[activities.length - 1]!.id;
    }
    resumeAfter = after;
    return { activities: [...seen.values()], complete: false, pages: MAX_PAGES, startedAfter };
  };
  return {
    scanWaitingActivities,
    async listWaitingActivities() {
      return (await scanWaitingActivities()).activities;
    },
    async getActivity(activityId) {
      return ((await call("/public/v1/query/get_activity", { organizationId: config.organizationId, activityId })).activity) as TurnkeyActivity;
    },
    approve: vote("APPROVE"),
    reject: vote("REJECT")
  };
}
