import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { turnkeyHttpApi, TurnkeyApiError, type ActivityScan, type TurnkeyActivity, type TurnkeyApi } from "../src/turnkey/api.js";
import { TurnkeyApprover, type GuardedWallet, type TurnkeyGate, type TurnkeyRetryPolicy } from "../src/turnkey/approver.js";
import { TurnkeyLifecycleStore } from "../src/turnkey/lifecycle-store.js";
import { openSqliteDatabase, serializeStoredValue } from "../src/storage/sqlite.js";
import type { SpendReservation } from "../src/policy/daily-spend-tracker.js";

function apiKey() {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(randomBytes(32));
  return { publicKey: ecdh.getPublicKey("hex", "compressed"), privateKey: ecdh.getPrivateKey("hex").padStart(64, "0") };
}

// ---- Paging: a stand-in for Turnkey's list call whose behaviour each test chooses. ----

type Item = { id: string };
interface Listing { items: Item[]; onCall?: (n: number, after: string | undefined) => void; respond?: (after: string | undefined, limit: number) => Item[] | Error }

function scanner(listing: Listing) {
  const key = apiKey();
  let calls = 0;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const after: string | undefined = body.paginationOptions.after;
    const limit = Number(body.paginationOptions.limit);
    listing.onCall?.(calls, after);
    const page = listing.respond ? listing.respond(after, limit) : listing.items.slice(after ? listing.items.findIndex((a) => a.id === after) + 1 : 0).slice(0, limit);
    if (page instanceof Error) return new Response(JSON.stringify({ message: page.message }), { status: 500 });
    const activities = page.map((item) => ({ ...item, organizationId: "org", status: "ACTIVITY_STATUS_CONSENSUS_NEEDED", type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", fingerprint: `f-${item.id}`, intent: {} }));
    return new Response(JSON.stringify({ activities }), { status: 200 });
  }) as unknown as typeof fetch;
  return { api: turnkeyHttpApi({ organizationId: "org", apiPublicKey: key.publicKey, apiPrivateKey: key.privateKey, fetchImpl }), calls: () => calls };
}
const items = (n: number, prefix = "a") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}` }));
const ids = (scan: ActivityScan) => scan.activities.map((a) => a.id);

test("scan: bounded per call, carries on next call, and says whether it reached the end", async () => {
  const listing = { items: [...items(2_050), { id: "guarded" }] };
  const { api, calls } = scanner(listing);
  const first = await api.scanWaitingActivities();
  assert.equal(calls(), 20);
  assert.equal(first.complete, false);
  assert.equal(first.activities.length, 2_000);
  const second = await api.scanWaitingActivities();
  assert.equal(second.complete, true);
  assert.equal(second.startedAfter, "a1999");
  assert.ok(ids(second).includes("guarded"));
  const third = await api.scanWaitingActivities();
  assert.equal(third.startedAfter, undefined, "after the end it wraps to the top, so earlier activities are seen again");
});

test("scan: a page that repeats earlier results stops the scan, and the next starts from the top", async () => {
  // After the first page, every page is part of the first one again, never what follows the cursor.
  const { api, calls } = scanner({ items: [], respond: (after) => (after ? items(50) : items(100)) });
  const scan = await api.scanWaitingActivities();
  assert.equal(calls(), 2, "no loop");
  assert.equal(scan.complete, false);
  assert.match(scan.error ?? "", /repeated/);
  assert.equal(scan.activities.length, 100, "duplicates counted once");
  assert.equal((await api.scanWaitingActivities()).startedAfter, undefined);
});

test("scan: overlapping pages are merged without duplicates and the scan still finishes", async () => {
  const all = items(250);
  // Each page starts 10 before the cursor, so consecutive pages share 10 activities.
  const { api } = scanner({ items: all, respond: (after, limit) => { const start = after ? Math.max(0, all.findIndex((a) => a.id === after) + 1 - 10) : 0; return all.slice(start, start + limit); } });
  const scan = await api.scanWaitingActivities();
  assert.equal(scan.complete, true);
  assert.deepEqual(ids(scan), all.map((a) => a.id));
});

test("scan: a cursor activity that disappears between pages does not stop progress", async () => {
  const all = items(2_100);
  // Turnkey does not document what `after` does for an id no longer in the list; here it fails, as an unknown id might.
  const { api } = scanner({ items: all, respond: (after, limit) => {
    if (after === "a1999") return new Error("unknown cursor");
    return all.slice(after ? all.findIndex((a) => a.id === after) + 1 : 0).slice(0, limit);
  } });
  assert.equal((await api.scanWaitingActivities()).complete, false); // stops at the cap with cursor a1999
  const retry = await api.scanWaitingActivities();
  assert.match(retry.error ?? "", /500/);
  assert.equal(retry.startedAfter, "a1999", "the first failure keeps the place");
  await api.scanWaitingActivities(); // fails a second time at the same cursor
  const fresh = await api.scanWaitingActivities();
  assert.equal(fresh.startedAfter, undefined, "after two failures there it starts again from the top");
  assert.ok(fresh.activities.length > 0);
});

test("scan: when the cursor activity is removed and the API answers with the first page again, there is no loop and the rest is still reached", async () => {
  const listing: Listing = { items: items(150) };
  // a99 leaves the list (approved elsewhere) between the first and second page; this API then starts from the top.
  listing.onCall = (n) => { if (n === 2) listing.items = listing.items.filter((a) => a.id !== "a99"); };
  listing.respond = (after, limit) => { const i = after ? listing.items.findIndex((a) => a.id === after) : -1; return listing.items.slice(i + 1).slice(0, limit); };
  const { api, calls } = scanner(listing);
  const scan = await api.scanWaitingActivities();
  assert.ok(calls() <= 5, `no loop (${calls()} calls)`);
  assert.equal(new Set(ids(scan)).size, ids(scan).length, "the restarted page adds no duplicates");
  const seen = new Set([...ids(scan), ...ids(await api.scanWaitingActivities())]);
  for (const id of ["a0", "a100", "a149"]) assert.ok(seen.has(id), `${id} is reached`);
});

test("scan: activities arriving during a scan are seen by this scan or the next", async () => {
  const listing: Listing = { items: items(250) };
  listing.onCall = (n) => {
    if (n === 2) { listing.items.unshift({ id: "new-at-top" }); listing.items.push({ id: "new-at-end" }); }
  };
  const { api } = scanner(listing);
  const scan = await api.scanWaitingActivities();
  assert.ok(ids(scan).includes("new-at-end"), "after the cursor: this scan");
  assert.ok(!ids(scan).includes("new-at-top"), "before the cursor: missed this time");
  assert.ok(ids(await api.scanWaitingActivities()).includes("new-at-top"), "and seen by the next");
});

test("scan: a failure part way keeps what was read and the next scan resumes where it failed", async () => {
  let failOnce = true;
  const all = items(350);
  const { api } = scanner({ items: all, respond: (after, limit) => {
    if (after === "a199" && failOnce) { failOnce = false; return new Error("temporarily unavailable"); }
    return all.slice(after ? all.findIndex((a) => a.id === after) + 1 : 0).slice(0, limit);
  } });
  const broken = await api.scanWaitingActivities();
  assert.equal(broken.complete, false);
  assert.equal(broken.activities.length, 200);
  assert.ok(broken.error);
  const resumed = await api.scanWaitingActivities();
  assert.equal(resumed.startedAfter, "a199");
  assert.equal(resumed.complete, true);
  assert.deepEqual(ids(resumed), all.slice(200).map((a) => a.id));
});

// ---- Lifecycle: a fake Turnkey and a fake gate that counts reservations. ----

const WALLET = "GuardedWa11et1111111111111111111111111111111";
const OTHER_GUARDED = "OtherGuardedWa11et111111111111111111111111111";

function activity(id: string, tx = "aabbcc", wallet = WALLET): TurnkeyActivity {
  return { id, organizationId: "org", status: "ACTIVITY_STATUS_CONSENSUS_NEEDED", type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", fingerprint: `fp-${id}`,
    intent: { signTransactionIntentV2: { signWith: wallet, unsignedTransaction: tx, type: "TRANSACTION_TYPE_SOLANA" } } };
}

type VoteResult = "ok" | "refused" | "unknown" | "pending" | "failed" | "no-id" | "rate-limited";
/**
 * A stand-in for Turnkey's activity API. A vote is its own activity: an identical request (same fingerprint and
 * timestampMs) returns the same vote activity, as Turnkey documents; `votes` lists the vote activities created.
 */
function fakeApi() {
  const activities = new Map<string, TurnkeyActivity>();
  const votes: Array<{ kind: string; fingerprint: string }> = [];
  const voteActivities = new Map<string, { id: string; status: string; fingerprint: string; kind: "APPROVE" | "REJECT" }>();
  const voteRequests: Array<{ kind: string; fingerprint: string; timestampMs: string }> = [];
  const voteQueries: string[] = [];
  /** Finishes a pending vote activity (as Turnkey would), counting the vote towards its signing activity if COMPLETED. */
  const settleVote = (voteId: string, status: string) => {
    const vote = [...voteActivities.values()].find((v) => v.id === voteId)!;
    vote.status = status;
    if (status === "ACTIVITY_STATUS_COMPLETED") for (const a of activities.values()) if (a.fingerprint === vote.fingerprint) a.status = vote.kind === "APPROVE" ? "ACTIVITY_STATUS_COMPLETED" : "ACTIVITY_STATUS_REJECTED";
  };
  const next: VoteResult[] = [];
  /** Activities the scan does not return, as if they were beyond its page cap. */
  const hidden = new Set<string>();
  const api: TurnkeyApi = {
    async scanWaitingActivities() { return { activities: [...activities.values()].filter((a) => a.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED" && !hidden.has(a.id)).map((a) => structuredClone(a)), complete: true, pages: 1 }; },
    async listWaitingActivities() { return (await this.scanWaitingActivities()).activities; },
    async getActivity(id) {
      const a = activities.get(id);
      if (a) return structuredClone(a);
      const vote = [...voteActivities.values()].find((v) => v.id === id);
      if (vote) { voteQueries.push(id); return { id: vote.id, organizationId: "org", status: vote.status, type: `ACTIVITY_TYPE_${vote.kind}_ACTIVITY`, fingerprint: `vfp-${vote.id}`, intent: {} } as TurnkeyActivity; }
      throw new TurnkeyApiError("not found", 404);
    },
    approve: (fingerprint, timestampMs) => submit("APPROVE", fingerprint, timestampMs),
    reject: (fingerprint, timestampMs) => submit("REJECT", fingerprint, timestampMs)
  };
  async function submit(kind: "APPROVE" | "REJECT", fingerprint: string, timestampMs: string) {
    voteRequests.push({ kind, fingerprint, timestampMs });
    const key = `${kind}:${fingerprint}:${timestampMs}`;
    const existing = voteActivities.get(key);
    if (existing) return { activityId: existing.id, status: existing.status };
    const result = kind === "APPROVE" ? next.shift() ?? "ok" : "ok";
    if (result === "refused") throw new TurnkeyApiError("vote refused", 400);
    if (result === "rate-limited") throw new TurnkeyApiError("Too many requests in a short period of time.", 429);
    if (result === "unknown") throw new Error("socket hang up");
    votes.push({ kind, fingerprint });
    const vote = { id: `vote-${voteActivities.size + 1}`, status: "ACTIVITY_STATUS_PENDING", fingerprint, kind };
    voteActivities.set(key, vote);
    if (result === "pending") return { activityId: vote.id, status: vote.status };
    if (result === "no-id") return {};
    settleVote(vote.id, result === "failed" ? "ACTIVITY_STATUS_FAILED" : "ACTIVITY_STATUS_COMPLETED");
    return { activityId: vote.id, status: vote.status };
  }
  return { api, activities, votes, next, hidden, voteActivities, voteRequests, voteQueries, settleVote };
}

/** The gate's budget and approvals, kept outside the approver so they survive a "restart" like the database would. */
function fakeWorld() {
  const reviews = new Map<string, { status: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED"; consumed: boolean; consumedBy?: string; hash: string; fingerprint: string }>();
  const reviewByKey = new Map<string, string>();
  /** Charges by id, as the real tracker keeps them: one live charge per id, refunded at most once. */
  const held = new Map<string, SpendReservation>();
  const state = { reserved: 0n, evaluations: 0, opened: 0, consumed: 0, fingerprint: "rev-1", decision: "review" as "allow" | "review", events: [] as Array<{ event: string; data: Record<string, unknown> }> };
  const hash = (tx: string) => createHash("sha256").update(tx).digest("hex");
  const charge = (id: string): SpendReservation => {
    const existing = held.get(id);
    if (existing) return existing;
    const reservation = { id, policyId: "p", date: "d", amounts: { native: 10n } };
    held.set(id, reservation);
    state.reserved += 10n;
    return reservation;
  };
  const gate: TurnkeyGate = {
    transactionHash: hash,
    policyFingerprint: () => state.fingerprint,
    async evaluate(tx, _wallet, key) {
      state.evaluations += 1;
      if (state.decision === "allow") return { allowed: true, reservation: charge(key), policyFingerprint: state.fingerprint };
      let reviewId = reviewByKey.get(key);
      if (!reviewId) {
        state.opened += 1;
        reviewId = `review-${state.evaluations}`;
        reviewByKey.set(key, reviewId);
        reviews.set(reviewId, { status: "PENDING", consumed: false, hash: hash(tx), fingerprint: state.fingerprint });
      }
      return { allowed: false, reviewId, policyFingerprint: state.fingerprint };
    },
    heldReservation: (key) => held.get(key),
    reviewStatus: (id) => reviews.get(id)?.status ?? "MISSING",
    consumeApproval(id, tx, _wallet, key) {
      const review = reviews.get(id);
      if (!review) return { ok: false, outcome: "not_found" };
      if (review.status !== "APPROVED") return { ok: false, outcome: "not_approved" };
      if (review.consumed) return { ok: false, outcome: "already_used" };
      if (review.hash !== hash(tx)) return { ok: false, outcome: "mismatch" };
      if (review.fingerprint !== state.fingerprint) return { ok: false, outcome: "policy_changed" };
      review.consumed = true;
      review.consumedBy = key;
      state.consumed += 1;
      return { ok: true, reservation: charge(key) };
    },
    recoverApproval(id, tx, _wallet, key) {
      const review = reviews.get(id);
      if (!review) return { ok: false, outcome: "not_found" };
      if (review.status !== "APPROVED") return { ok: false, outcome: "not_approved" };
      if (!review.consumed) return { ok: false, outcome: "not_consumed" };
      if (review.consumedBy !== key) return { ok: false, outcome: "consumed_elsewhere" };
      if (review.hash !== hash(tx)) return { ok: false, outcome: "mismatch" };
      if (review.fingerprint !== state.fingerprint) return { ok: false, outcome: "policy_changed" };
      return { ok: true, reservation: charge(key) };
    },
    releaseBudget(reservation: SpendReservation) {
      if (!held.delete(reservation.id)) return;
      state.reserved -= reservation.amounts.native ?? 0n;
    },
    record(_wallet, event, data) { state.events.push({ event, data }); }
  };
  return { gate, reviews, state, held, charge };
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-lifecycle-"));
  const path = join(dir, "db.sqlite");
  const turnkey = fakeApi();
  const world = fakeWorld();
  const wallets = new Map<string, GuardedWallet>([[WALLET, { policyId: "p", agentId: "agent" }], [OTHER_GUARDED, { policyId: "p", agentId: "agent" }]]);
  /** A clock the tests move; backoff is zero unless a test asks for it, so "the next poll" acts at once. */
  const clock = { now: Date.UTC(2026, 10, 10, 12, 0, 0) };
  /** A fresh approver over the same database: what a process restart looks like. */
  const boot = (retry: Partial<TurnkeyRetryPolicy> = { baseDelayMs: 0, maxDelayMs: 0 }) =>
    new TurnkeyApprover({ api: turnkey.api, wallets, gate: world.gate, lifecycle: new TurnkeyLifecycleStore({ persistencePath: path }), retry, now: () => clock.now, random: () => 0.5 });
  const store = () => new TurnkeyLifecycleStore({ persistencePath: path });
  return { turnkey, world, boot, store, clock, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("lifecycle: restart after a review is opened does not open another; restart after approval votes once", async () => {
  const h = harness();
  try {
    h.turnkey.activities.set("x", activity("x"));
    await h.boot().poll();
    assert.equal(h.store().get("org", "x")?.state, "REVIEW_OPEN");
    await h.boot().poll(); // restart while the review is open
    assert.equal(h.world.state.evaluations, 1, "one review");

    h.world.reviews.get("review-1")!.status = "APPROVED"; // approved while no process was running
    const after = h.boot();
    await after.poll();
    await after.poll();
    assert.deepEqual(h.turnkey.votes, [{ kind: "APPROVE", fingerprint: "fp-x" }]);
    assert.equal(h.store().get("org", "x")?.voteActivityStatus, "ACTIVITY_STATUS_COMPLETED", "the vote completed");
    assert.equal(h.store().get("org", "x")?.state, "SIGNING_COMPLETED", "and the watched signing request was then seen completed");
    assert.equal(h.world.state.consumed, 1);
    assert.equal(h.world.state.reserved, 10n);
  } finally { h.cleanup(); }
});

test("lifecycle: duplicate polls and webhooks open one review and send one vote", async () => {
  const h = harness();
  try {
    h.turnkey.activities.set("x", activity("x"));
    const approver = h.boot();
    await Promise.all([approver.poll(), approver.poll(), approver.handle(activity("x")), approver.handle(activity("x"))]);
    await approver.poll();
    assert.equal(h.world.state.evaluations, 1);
    h.world.reviews.get("review-1")!.status = "APPROVED";
    await Promise.all([approver.poll(), approver.poll(), approver.handle(activity("x"))]);
    await approver.poll();
    assert.equal(h.turnkey.votes.length, 1);
  } finally { h.cleanup(); }
});

test("lifecycle: an unknown vote outcome keeps the reservation, and after a restart the same request is replayed, not a new vote", async () => {
  const h = harness();
  try {
    h.turnkey.activities.set("x", activity("x"));
    await h.boot().poll();
    h.world.reviews.get("review-1")!.status = "APPROVED";
    h.turnkey.next.push("unknown");
    await h.boot().poll();
    assert.equal(h.store().get("org", "x")?.state, "VOTE_UNKNOWN");
    assert.equal(h.world.state.reserved, 10n, "kept while the outcome is unknown");
    assert.ok(h.store().get("org", "x")?.reservation, "and remembered across a restart");

    await h.boot().poll(); // restart: the recorded request is sent again exactly, which Turnkey answers with one activity
    assert.equal(h.turnkey.voteRequests.length, 2);
    assert.equal(h.turnkey.voteRequests[0]!.timestampMs, h.turnkey.voteRequests[1]!.timestampMs, "an identical request, not a new vote");
    assert.equal(h.turnkey.votes.length, 1, "one vote activity");
    assert.equal(h.store().get("org", "x")?.state, "APPROVED");
    assert.equal(h.world.state.consumed, 1, "the approval is spent once");
    assert.equal(h.world.state.reserved, 10n, "the budget is charged once");
  } finally { h.cleanup(); }
});

test("lifecycle: a crash after recording the vote but before hearing back is recovered by reading the activity, not by guessing", async () => {
  const h = harness();
  try {
    // What a crash leaves behind: VOTING records, budget reserved, no answer to the vote. Turnkey has since completed
    // one (the vote had counted) and still waits on the other (it had not been sent).
    const store = h.store();
    for (const [id, tx] of [["done", "aabbcc"], ["waiting", "ddeeff"]] as const) {
      h.turnkey.activities.set(id, activity(id, tx));
      store.claim({ organizationId: "org", activityId: id, voteFingerprint: `fp-${id}`, wallet: WALLET, agentId: "agent", policyId: "p", transactionHash: h.world.gate.transactionHash(Buffer.from(tx, "hex").toString("base64"))! });
      store.update("org", id, { state: "VOTING", policyFingerprint: "rev-1", reservation: h.world.charge(`turnkey:org:${id}`) });
    }
    h.turnkey.activities.get("done")!.status = "ACTIVITY_STATUS_COMPLETED";
    await h.boot().poll();
    assert.equal(h.store().get("org", "done")?.state, "SIGNING_COMPLETED", "completed: the signing request finished (which vote counted is not claimed)");
    assert.ok(!h.turnkey.votes.some((v) => v.fingerprint === "fp-done"), "and is not sent again");
    assert.equal(h.store().get("org", "waiting")?.state, "APPROVED", "still waiting: voted, on the reservation already held");
    assert.equal(h.world.state.evaluations, 0, "neither was checked again");
    assert.equal(h.world.state.reserved, 20n, "nothing was charged twice");
  } finally { h.cleanup(); }
});

test("lifecycle: a vote whose outcome is unknown is not sent again once the policy has changed; the request is rejected", async () => {
  const h = harness();
  try {
    h.world.state.decision = "allow";
    h.turnkey.activities.set("x", activity("x"));
    h.turnkey.next.push("unknown");
    await h.boot().poll();
    h.world.state.fingerprint = "rev-2";
    await h.boot().poll();
    assert.deepEqual(h.turnkey.voteRequests.map((v) => v.kind), ["APPROVE", "REJECT"], "the approve request is not sent again");
    assert.equal(h.store().get("org", "x")?.state, "REJECTED");
    assert.equal(h.world.state.reserved, 10n, "kept: the first vote may have counted");
  } finally { h.cleanup(); }
});

test("lifecycle: a refused vote, first or repeated, keeps the reservation, and a later Turnkey rejection does not give it back", async () => {
  const h = harness();
  try {
    h.world.state.decision = "allow";
    h.turnkey.activities.set("first", activity("first"));
    h.turnkey.next.push("refused");
    await h.boot().poll();
    assert.equal(h.store().get("org", "first")?.state, "VOTE_REFUSED");
    assert.equal(h.world.state.reserved, 10n, "an HTTP refusal does not prove nothing will be signed: the charge stays");

    h.turnkey.activities.set("retry", activity("retry", "ddeeff"));
    h.turnkey.next.push("unknown", "refused");
    await h.boot().poll();
    await h.boot().poll();
    assert.equal(h.store().get("org", "retry")?.state, "VOTE_UNKNOWN", "a refusal of a repeat request may mean the first counted");
    assert.equal(h.world.state.reserved, 20n);
    h.turnkey.activities.get("retry")!.status = "ACTIVITY_STATUS_REJECTED"; // Turnkey settles it
    await h.boot().poll();
    assert.equal(h.store().get("org", "retry")?.state, "RESOLVED_EXTERNALLY");
    assert.equal(h.world.state.reserved, 20n, "REJECTED is not documented to rule out a signature, so the charge stays counted");
  } finally { h.cleanup(); }
});

test("lifecycle: a refused vote via review keeps the budget, and the spent approval is not handed back for reuse", async () => {
  const h = harness();
  try {
    h.turnkey.activities.set("x", activity("x"));
    await h.boot().poll();
    h.world.reviews.get("review-1")!.status = "APPROVED";
    h.turnkey.next.push("refused");
    await h.boot().poll();
    assert.equal(h.store().get("org", "x")?.state, "VOTE_REFUSED");
    assert.equal(h.world.state.reserved, 10n);
    assert.equal(h.world.reviews.get("review-1")!.consumed, true, "the approval stays used while the signing outcome is unknown");
    assert.match(h.store().get("org", "x")!.detail ?? "", /^VOTE_REFUSED: .*ACCOUNTING_RETAINED/);
  } finally { h.cleanup(); }
});

test("lifecycle: an activity resolved outside AgentGuard is recorded as such and not voted on", async () => {
  const h = harness();
  try {
    h.turnkey.activities.set("x", activity("x"));
    await h.boot().poll();
    h.turnkey.activities.get("x")!.status = "ACTIVITY_STATUS_REJECTED"; // cancelled on Turnkey's side
    h.world.reviews.get("review-1")!.status = "APPROVED";
    await h.boot().poll();
    assert.equal(h.store().get("org", "x")?.state, "RESOLVED_EXTERNALLY");
    assert.equal(h.turnkey.votes.length, 0);
    assert.equal(h.world.state.consumed, 0, "the approval was not spent");
    assert.ok(h.world.state.events.some((e) => e.event === "turnkey_resolved"));
  } finally { h.cleanup(); }
});

test("lifecycle: an activity whose transaction or wallet no longer matches the record is rejected, never approved", async () => {
  for (const change of ["transaction", "wallet"] as const) {
    const h = harness();
    try {
      h.turnkey.activities.set("x", activity("x"));
      await h.boot().poll();
      h.world.reviews.get("review-1")!.status = "APPROVED";
      h.turnkey.activities.set("x", change === "transaction" ? activity("x", "ffffff") : activity("x", "aabbcc", OTHER_GUARDED));
      await h.boot().poll();
      assert.deepEqual(h.turnkey.votes, [{ kind: "REJECT", fingerprint: "fp-x" }], change);
      assert.equal(h.store().get("org", "x")?.state, "MISMATCH", change);
      assert.equal(h.world.state.consumed, 0, `${change}: the approval was not spent`);
    } finally { h.cleanup(); }
  }
});

test("lifecycle: records are scoped to the organization, and finished ones are pruned by retention", async () => {
  const h = harness();
  try {
    const store = h.store();
    const base = { activityId: "same", voteFingerprint: "fp", wallet: WALLET, agentId: "agent", policyId: "p", transactionHash: "h" };
    assert.equal(store.claim({ ...base, organizationId: "org-a" }), true);
    assert.equal(store.claim({ ...base, organizationId: "org-b" }), true, "the same activity id in another organization is another record");
    assert.equal(store.claim({ ...base, organizationId: "org-a" }), false);
    store.update("org-a", "same", { state: "APPROVED" });
    assert.equal(store.pruneBatch(new Date(Date.now() + 1_000).toISOString(), 100), 0, "a completed vote whose signing request is still watched is kept");
    store.update("org-a", "same", { state: "SIGNING_COMPLETED" });
    assert.equal(store.pruneBatch(new Date(Date.now() + 1_000).toISOString(), 100), 1, "only the finished record is pruned");
    assert.equal(store.get("org-b", "same")?.state, "EVALUATING");
  } finally { h.cleanup(); }
});

test("lifecycle: many requests waiting on a person do not stop a decided one from being acted on", async () => {
  const h = harness();
  try {
    for (let i = 0; i < 70; i++) h.turnkey.activities.set(`w${i}`, activity(`w${i}`, (i + 16).toString(16).padStart(2, "0")));
    const approver = h.boot();
    await approver.poll();
    assert.equal(h.world.state.evaluations, 70);
    // The last one is decided, and the scan no longer returns it; only the read-back by id can reach it.
    h.turnkey.hidden.add("w69");
    h.world.reviews.get("review-70")!.status = "APPROVED";
    for (let i = 0; i < 3 && h.turnkey.votes.length === 0; i++) { h.turnkey.hidden.clear(); for (let j = 0; j < 70; j++) h.turnkey.hidden.add(`w${j}`); await approver.poll(); }
    assert.deepEqual(h.turnkey.votes, [{ kind: "APPROVE", fingerprint: "fp-w69" }], "reached within a few polls, past 50 records still waiting");
  } finally { h.cleanup(); }
});

test("lifecycle: an older activity table gains the vote columns in place, twice safely; legacy records stay recoverable and keep their charges", async () => {
  const h = harness();
  try {
    // The table as the first release created it, holding a record mid-vote and a refused vote whose refund the old
    // code had not finished.
    const path = join(tmpdir(), `agentguard-legacy-${Date.now()}-${Math.random()}.sqlite`);
    const old = openSqliteDatabase(path);
    old.exec(`CREATE TABLE turnkey_activities (organization_id TEXT NOT NULL, activity_id TEXT NOT NULL, vote_fingerprint TEXT NOT NULL, wallet TEXT NOT NULL,
      customer_id TEXT, agent_id TEXT NOT NULL, policy_id TEXT NOT NULL, policy_fingerprint TEXT, transaction_hash TEXT NOT NULL, review_id TEXT,
      state TEXT NOT NULL, reservation_json TEXT, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (organization_id, activity_id)) STRICT;`);
    const hash = h.world.gate.transactionHash(Buffer.from("aabbcc", "hex").toString("base64"))!;
    const now = new Date().toISOString();
    const charge = (id: string) => serializeStoredValue(h.world.charge(`turnkey:org:${id}`));
    const insert = old.prepare("INSERT INTO turnkey_activities VALUES ('org', ?, ?, ?, NULL, 'agent', 'p', 'rev-1', ?, NULL, ?, ?, NULL, ?, ?)");
    insert.run("mid-vote", "fp-mid-vote", WALLET, hash, "VOTING", charge("mid-vote"), now, now);
    insert.run("refused", "fp-refused", WALLET, hash, "VOTE_REFUSED", charge("refused"), now, now);
    h.turnkey.activities.set("mid-vote", activity("mid-vote"));
    h.turnkey.activities.set("refused", activity("refused"));
    h.world.state.fingerprint = "rev-1";

    new TurnkeyLifecycleStore({ persistencePath: path });
    const store = new TurnkeyLifecycleStore({ persistencePath: path });
    const columns = (openSqliteDatabase(path).prepare("PRAGMA table_info(turnkey_activities)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["vote_kind", "vote_timestamp_ms", "vote_activity_id", "vote_activity_status", "vote_submissions", "retries", "next_check_at"]) assert.ok(columns.includes(c), c);
    assert.equal(store.get("org", "mid-vote")!.voteSubmissions, 0, "nothing invented for old rows");

    const approver = new TurnkeyApprover({ api: h.turnkey.api, wallets: new Map([[WALLET, { policyId: "p", agentId: "agent" }]]), gate: h.world.gate, lifecycle: store, retry: { baseDelayMs: 0, maxDelayMs: 0 } });
    await approver.poll();
    const mid = store.get("org", "mid-vote")!;
    assert.equal(mid.state, "APPROVED", "a legacy mid-vote record is voted on (counted as one request already sent)");
    assert.equal(mid.voteSubmissions, 2);
    assert.equal(store.get("org", "refused")!.state, "VOTE_REFUSED", "a legacy refused vote is left as it was");
    assert.equal(h.world.state.reserved, 20n, "neither charge was refunded or charged again");
    rmSync(path, { force: true });
  } finally { h.cleanup(); }
});

test("lifecycle: an old table whose transaction_hash is NOT NULL is rebuilt once, keeping every row; legacy finished votes are watched again", async () => {
  const h = harness();
  const path = join(tmpdir(), `agentguard-rebuild-${Date.now()}-${Math.random()}.sqlite`);
  try {
    const old = openSqliteDatabase(path);
    old.exec(`CREATE TABLE turnkey_activities (organization_id TEXT NOT NULL, activity_id TEXT NOT NULL, vote_fingerprint TEXT NOT NULL, wallet TEXT NOT NULL,
      customer_id TEXT, agent_id TEXT NOT NULL, policy_id TEXT NOT NULL, policy_fingerprint TEXT, transaction_hash TEXT NOT NULL, review_id TEXT,
      state TEXT NOT NULL, reservation_json TEXT, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (organization_id, activity_id)) STRICT;
      CREATE INDEX turnkey_activities_review ON turnkey_activities (review_id) WHERE review_id IS NOT NULL;`);
    const hash = h.world.gate.transactionHash(Buffer.from("aabbcc", "hex").toString("base64"))!;
    const recent = new Date(h.clock.now - 60_000).toISOString();
    const longAgo = new Date(h.clock.now - 30 * 86_400_000).toISOString();
    const insert = old.prepare("INSERT INTO turnkey_activities VALUES ('org', ?, ?, ?, NULL, 'agent', 'p', 'rev-1', ?, 'rev-x', ?, ?, NULL, ?, ?)");
    insert.run("voted", "fp-voted", WALLET, hash, "APPROVED", serializeStoredValue(h.world.charge("turnkey:org:voted")), recent, recent);
    insert.run("refused", "fp-refused", WALLET, hash, "VOTE_REFUSED", serializeStoredValue(h.world.charge("turnkey:org:refused")), longAgo, longAgo);
    for (const id of ["voted", "refused"]) h.turnkey.activities.set(id, activity(id));

    new TurnkeyLifecycleStore({ persistencePath: path });
    const store = new TurnkeyLifecycleStore({ persistencePath: path }); // a second start: nothing left to do
    const info = openSqliteDatabase(path).prepare("PRAGMA table_info(turnkey_activities)").all() as Array<{ name: string; notnull: number }>;
    assert.equal(info.find((c) => c.name === "transaction_hash")!.notnull, 0, "transaction_hash is nullable now");
    assert.ok(info.some((c) => c.name === "purpose") && info.some((c) => c.name === "watch_since"));
    const indexes = (openSqliteDatabase(path).prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'turnkey_activities'").all() as Array<{ name: string }>).map((r) => r.name);
    assert.ok(indexes.includes("turnkey_activities_review") && indexes.includes("turnkey_activities_state_updated"));
    assert.deepEqual([store.get("org", "voted")!.purpose, store.get("org", "voted")!.transactionHash, store.get("org", "voted")!.reviewId], ["GUARD", hash, "rev-x"], "rows kept as they were");
    assert.ok(store.claim({ organizationId: "org", activityId: "unreadable", voteFingerprint: "fp-u", wallet: WALLET, agentId: "agent", policyId: "p", purpose: "REJECT_ONLY" }), "a record without a hash fits");

    const approver = new TurnkeyApprover({ api: h.turnkey.api, wallets: new Map([[WALLET, { policyId: "p", agentId: "agent" }]]), gate: h.world.gate, lifecycle: store, retry: { baseDelayMs: 0, maxDelayMs: 0 }, now: () => h.clock.now });
    await approver.poll();
    assert.equal(store.get("org", "voted")!.state, "APPROVED", "a recent legacy completed vote is watched");
    assert.equal(store.get("org", "refused")!.state, "SIGNING_UNRESOLVED", "a legacy refusal older than the horizon is handed to an operator after one read");
    h.turnkey.activities.get("voted")!.status = "ACTIVITY_STATUS_COMPLETED";
    await approver.poll();
    assert.equal(store.get("org", "voted")!.state, "SIGNING_COMPLETED");
    assert.equal(h.turnkey.votes.length, 0, "no vote was sent for either legacy record");
    assert.equal(h.world.state.reserved, 20n, "no charge was given back");
  } finally { h.cleanup(); rmSync(path, { force: true }); }
});

// ---- Single-active-poller lease: only one process advances the lifecycle, so concurrent replicas never double-vote. ----

test("lease: one owner holds it at a time; its own renews, a rival waits until it lapses, a release frees it at once", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-lease-"));
  const path = join(dir, "db.sqlite");
  try {
    const store = new TurnkeyLifecycleStore({ persistencePath: path });
    const t0 = Date.UTC(2026, 10, 10, 12, 0, 0);
    assert.equal(store.acquireLease("poller", "A", t0, 30_000), true, "a free lease is granted");
    assert.equal(store.acquireLease("poller", "B", t0, 30_000), false, "a rival is refused while A holds an unexpired lease");
    assert.equal(store.acquireLease("poller", "A", t0 + 10_000, 30_000), true, "the holder renews its own lease");
    assert.equal(store.acquireLease("poller", "B", t0 + 20_000, 30_000), false, "still A's: the renewal pushed the expiry out");
    assert.equal(store.acquireLease("poller", "B", t0 + 40_001, 30_000), true, "once A's renewed lease lapses, B takes over (crash failover)");
    store.releaseLease("poller", "A"); assert.equal(store.acquireLease("poller", "C", t0 + 41_000, 30_000), false, "a release by a non-holder does nothing");
    store.releaseLease("poller", "B");
    assert.equal(store.acquireLease("poller", "C", t0 + 41_000, 30_000), true, "the holder's release frees the lease before it would lapse");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("lease: two replicas polling the same re-votable record together submit the vote once, not once each", async () => {
  // A VOTE_UNKNOWN record whose prior request has aged out of the replay window is re-votable. Two approvers share
  // one database (two replicas) and poll at the same instant, each with a vote submission that yields the event loop
  // so a rival reaches the same point before either records. Without the lease both read the old vote count and both
  // submit (measured: two approve calls for one signing request). With it, only the lease holder advances and the
  // other stands by, so exactly one approve call is made. The in-process guard (this.polling) cannot help here: these
  // are two separate approver instances, as two processes would be.
  const h = harness();
  try {
    const txHash = h.world.gate.transactionHash("aabbcc");
    h.turnkey.activities.set("x", activity("x")); // CONSENSUS_NEEDED, fingerprint fp-x, tx aabbcc
    const seed = h.store();
    seed.claim({ organizationId: "org", activityId: "x", voteFingerprint: "fp-x", wallet: WALLET, agentId: "agent", policyId: "p", transactionHash: txHash, policyFingerprint: "rev-1" });
    const old = String(h.clock.now - 2 * 60 * 60_000); // 2h ago: outside the replay window, so a fresh timestamp is used
    seed.update("org", "x", { state: "VOTE_UNKNOWN", voteKind: "APPROVE", voteTimestampMs: old, voteSubmissions: 1 });

    // Make each vote submission yield, so a concurrent poller reaches the submit point too, forcing the overlap.
    const realApprove = h.turnkey.api.approve.bind(h.turnkey.api);
    h.turnkey.api.approve = async (fingerprint: string, timestampMs: string) => { for (let i = 0; i < 50; i++) await Promise.resolve(); return realApprove(fingerprint, timestampMs); };

    const a = h.boot();
    const b = h.boot();
    await Promise.all([a.poll(), b.poll()]);

    assert.equal(h.turnkey.voteRequests.length, 1, "exactly one approve call is made for the one signing request");
    assert.equal(h.turnkey.votes.length, 1, "and so exactly one vote activity exists");
    assert.equal([a.status().standby, b.status().standby].filter(Boolean).length, 1, "one approver advanced, the other stood by");
  } finally { h.cleanup(); }
});
