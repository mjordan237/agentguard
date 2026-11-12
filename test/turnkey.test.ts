import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha256";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createServer } from "../src/api/server.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";
import { ApiKeyStamper } from "../src/turnkey/stamp.js";
import { turnkeyHttpApi, type TurnkeyActivity } from "../src/turnkey/api.js";
import type { GuardedWallet, TurnkeyApprover, TurnkeyRetryPolicy } from "../src/turnkey/approver.js";
import type { Policy } from "../src/policy/types.js";
import type { AuditLog } from "../src/observability/audit-log.js";
import { TurnkeyLifecycleStore, type ActivityUpdate } from "../src/turnkey/lifecycle-store.js";
import { DailySpendTracker } from "../src/policy/daily-spend-tracker.js";
import { openSqliteDatabase } from "../src/storage/sqlite.js";
import { CustomerStore } from "../src/customers/customer-store.js";

function apiKey() {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(randomBytes(32));
  return { publicKey: ecdh.getPublicKey("hex", "compressed"), privateKey: ecdh.getPrivateKey("hex").padStart(64, "0") };
}

/** Checks a stamp the way Turnkey describes it, with an independent P-256 implementation. */
function verifyStamp(stamp: string, body: string, expectedPublicKey: string): boolean {
  const decoded = JSON.parse(Buffer.from(stamp, "base64url").toString("utf8")) as { publicKey: string; scheme: string; signature: string };
  if (decoded.scheme !== "SIGNATURE_SCHEME_TK_API_P256" || decoded.publicKey !== expectedPublicKey) return false;
  // Strict: DER, and low-S only.
  return p256.verify(Buffer.from(decoded.signature, "hex"), sha256(new TextEncoder().encode(body)), Buffer.from(decoded.publicKey, "hex"), { format: "der", lowS: true, prehash: false });
}

test("a stamp is an ECDSA P-256 signature over the exact body, and a mismatched key pair is refused", () => {
  const key = apiKey();
  const stamper = new ApiKeyStamper(key.publicKey, key.privateKey);
  const body = JSON.stringify({ organizationId: "org", activityId: "a" });
  const stamp = stamper.stamp(body);
  assert.equal(verifyStamp(stamp, body, key.publicKey), true);
  // Node signs with either s; every one of many stamps must still be low-S.
  for (let i = 0; i < 200; i++) assert.equal(verifyStamp(stamper.stamp(`${body}${i}`), `${body}${i}`, key.publicKey), true, `stamp ${i}`);
  assert.equal(verifyStamp(stamp, `${body} `, key.publicKey), false, "the signature covers the exact bytes");
  assert.throws(() => new ApiKeyStamper(apiKey().publicKey, key.privateKey), /does not belong/);
});

/** A stand-in Turnkey API: serves waiting activities and records votes. Every request must carry a valid stamp. */
/**
 * A vote is itself an activity. Turnkey answers approve_activity and reject_activity with that APPROVE/REJECT
 * activity and its status (docs.turnkey.com/api-reference/activities/approve-activity); only a COMPLETED one
 * counts, as the official SDK treats it. `voteStatus` sets the status the next votes get.
 */
async function fakeTurnkey(publicKey: string, options: { approveStatus?: number } = {}) {
  const activities = new Map<string, TurnkeyActivity>();
  const control = {
    /** Status a new vote activity gets. PENDING ones stay pending until settleVote. */
    voteStatus: "ACTIVITY_STATUS_COMPLETED",
    /** "missing": answer 200 with no activity; "malformed": answer 200 with a body that is not JSON. */
    voteAnswer: "normal" as "normal" | "missing" | "malformed",
    /** Answer this many of the next requests (of any kind) with 429, as Turnkey does when rate limiting. */
    rateLimitNext: 0,
    /** A completed approve vote does not complete the signing activity: another approver is still needed. */
    anotherApproverNeeded: false,
    /** Answer this many of the next vote submissions with 429. */
    rateLimitVotesNext: 0,
    /** Answer this many get_activity calls with 500. */
    failReadsNext: 0,
    /** Runs before a vote is answered, e.g. to have another approver complete the signing activity first. */
    beforeVote: undefined as undefined | ((kind: "APPROVE" | "REJECT", fingerprint: string) => void)
  };
  /** Vote activities by request (kind, fingerprint, timestampMs): an identical request gets the same one back. */
  const voteActivities = new Map<string, { id: string; status: string; fingerprint: string; kind: "APPROVE" | "REJECT" }>();
  const requests: Array<{ url: string; activityId?: string; timestampMs?: string }> = [];
  const settleVote = (voteId: string, status: string) => {
    const vote = [...voteActivities.values()].find((v) => v.id === voteId)!;
    vote.status = status;
    if (status !== "ACTIVITY_STATUS_COMPLETED" || (vote.kind === "APPROVE" && control.anotherApproverNeeded)) return;
    for (const activity of activities.values()) if (activity.fingerprint === vote.fingerprint) activity.status = vote.kind === "APPROVE" ? "ACTIVITY_STATUS_COMPLETED" : "ACTIVITY_STATUS_REJECTED";
  };
  const votes: Array<{ kind: string; fingerprint: string }> = [];
  let badStamps = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!verifyStamp(String(req.headers["x-stamp"] ?? ""), raw, publicKey)) { badStamps += 1; res.writeHead(401); return void res.end("{}"); }
      const body = JSON.parse(raw);
      const reply = (status: number, payload: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(payload)); };
      requests.push({ url: String(req.url), ...(body.activityId ? { activityId: body.activityId } : {}), ...(body.timestampMs ? { timestampMs: body.timestampMs } : {}) });
      if (control.rateLimitNext > 0) { control.rateLimitNext -= 1; return reply(429, { message: "Too many requests in a short period of time. Please wait a few minutes and try again." }); }
      if (req.url === "/public/v1/query/list_activities") {
        // Pages like Turnkey: 10 by default, at most 100, continuing after the cursor's activity.
        const matching = [...activities.values()].filter((a) => body.filterByStatus.includes(a.status) && body.filterByType.includes(a.type));
        const limit = Math.min(Number(body.paginationOptions?.limit ?? 10), 100);
        const start = body.paginationOptions?.after ? matching.findIndex((a) => a.id === body.paginationOptions.after) + 1 : 0;
        return reply(200, { activities: matching.slice(start, start + limit) });
      }
      if (req.url === "/public/v1/query/get_activity") {
        if (control.failReadsNext > 0) { control.failReadsNext -= 1; return reply(500, { message: "internal" }); }
        const vote = [...voteActivities.values()].find((v) => v.id === body.activityId);
        return reply(200, { activity: activities.get(body.activityId) ?? (vote && { id: vote.id, organizationId: "org", type: `ACTIVITY_TYPE_${vote.kind}_ACTIVITY`, status: vote.status, fingerprint: `vfp-${vote.id}` }) });
      }
      const kind = req.url === "/public/v1/submit/approve_activity" ? "APPROVE" : req.url === "/public/v1/submit/reject_activity" ? "REJECT" : undefined;
      if (!kind || body.type !== `ACTIVITY_TYPE_${kind}_ACTIVITY`) return reply(404, {});
      if (control.rateLimitVotesNext > 0) { control.rateLimitVotesNext -= 1; return reply(429, { message: "Too many requests in a short period of time. Please wait a few minutes and try again." }); }
      control.beforeVote?.(kind, body.parameters.fingerprint);
      if (kind === "APPROVE" && options.approveStatus) return reply(options.approveStatus, { message: "vote refused" });
      const key = `${kind}:${body.parameters.fingerprint}:${body.timestampMs}`;
      let vote = voteActivities.get(key);
      if (!vote) {
        votes.push({ kind, fingerprint: body.parameters.fingerprint });
        vote = { id: `vote-${voteActivities.size + 1}`, status: "ACTIVITY_STATUS_PENDING", fingerprint: body.parameters.fingerprint, kind };
        voteActivities.set(key, vote);
        if (control.voteStatus !== "ACTIVITY_STATUS_PENDING") settleVote(vote.id, control.voteStatus);
      }
      if (control.voteAnswer === "missing") return reply(200, {});
      if (control.voteAnswer === "malformed") { res.writeHead(200, { "content-type": "application/json" }); return void res.end("<html>gateway</html>"); }
      return reply(200, { activity: { id: vote.id, organizationId: "org", type: body.type, status: vote.status, fingerprint: `vfp-${vote.id}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, activities, votes, control, voteActivities, settleVote, requests, badStamps: () => badStamps, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

let counter = 0;
function signingRequest(wallet: PublicKey, to: PublicKey, type = "ACTIVITY_TYPE_SIGN_TRANSACTION_V2"): TurnkeyActivity {
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: to, lamports: 100_000_000 })] }).compileToV0Message());
  const unsignedTransaction = Buffer.from(tx.serialize()).toString("hex");
  counter += 1;
  return {
    id: `activity-${counter}`, organizationId: "org", status: "ACTIVITY_STATUS_CONSENSUS_NEEDED", type, fingerprint: `fingerprint-${counter}`,
    intent: type === "ACTIVITY_TYPE_SIGN_TRANSACTION_V2"
      ? { signTransactionIntentV2: { signWith: wallet.toBase58(), unsignedTransaction, type: "TRANSACTION_TYPE_SOLANA" } }
      : { solSendTransactionIntentV2: { signWiths: [wallet.toBase58()], unsignedTransaction } }
  };
}

async function setup(options: { approveStatus?: number; persistencePath?: string; lifecycle?: TurnkeyLifecycleStore; assignment?: Partial<GuardedWallet>; editPolicy?: (policy: Policy) => Policy; retry?: Partial<TurnkeyRetryPolicy>; now?: () => number; reuse?: { key: ReturnType<typeof apiKey>; turnkey: Awaited<ReturnType<typeof fakeTurnkey>>; wallet: PublicKey; vendor: PublicKey } } = {}) {
  const key = options.reuse?.key ?? apiKey();
  const turnkey = options.reuse?.turnkey ?? await fakeTurnkey(key.publicKey, options);
  const wallet = options.reuse?.wallet ?? Keypair.generate().publicKey, vendor = options.reuse?.vendor ?? Keypair.generate().publicKey;
  const secret = "t".repeat(40);
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const demo = buildDemoPolicy([vendor.toBase58()]);
  const policies = new Map([["demo", options.editPolicy ? options.editPolicy(demo) : demo], ["demo-copy", demo]]);
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder", reviewActionSecret: secret, persistencePath: options.persistencePath,
    auditLog: { append: (_c: string | undefined, type: string, data: Record<string, unknown>) => { events.push({ type, data }); }, list: () => [], verify: () => ({ ok: true }) } as unknown as AuditLog,
    turnkey: { api: turnkeyHttpApi({ organizationId: "org", apiPublicKey: key.publicKey, apiPrivateKey: key.privateKey, baseUrl: turnkey.url }), wallets: { [wallet.toBase58()]: { policyId: "demo", agentId: "turnkey-agent", ...options.assignment } }, autoStart: false, lifecycle: options.lifecycle, retry: options.retry ?? { baseDelayMs: 0, maxDelayMs: 0 }, now: options.now, random: () => 0.5 }
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const approver = app.locals.turnkeyApprover as TurnkeyApprover;
  return {
    key, turnkey, wallet, vendor, approver, events, base, secret, policies,
    closeServer: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
    review: (reviewId: string, action: "approve" | "deny") => fetch(`${base}/review/${reviewId}/${action}`, { method: "POST", headers: { "x-review-action-secret": secret }, redirect: "manual" }),
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await turnkey.close(); }
  };
}

test("a Turnkey request within policy is approved; one for an unguarded wallet is left alone", async () => {
  const t = await setup();
  try {
    const ok = signingRequest(t.wallet, t.vendor);
    const other = signingRequest(Keypair.generate().publicKey, t.vendor);
    t.turnkey.activities.set(ok.id, ok).set(other.id, other);
    await t.approver.poll();
    assert.deepEqual(t.turnkey.votes, [{ kind: "APPROVE", fingerprint: ok.fingerprint }]);
    assert.ok(t.events.some((e) => e.type === "turnkey_approved" && e.data.activityId === ok.id));
    assert.equal(t.turnkey.badStamps(), 0, "every call to Turnkey was correctly stamped");
  } finally {
    await t.close();
  }
});

test("a Turnkey request outside policy waits for a person, then follows the decision", async () => {
  const t = await setup();
  try {
    const approved = signingRequest(t.wallet, Keypair.generate().publicKey);
    const denied = signingRequest(t.wallet, Keypair.generate().publicKey);
    t.turnkey.activities.set(approved.id, approved).set(denied.id, denied);
    await t.approver.poll();
    assert.equal(t.turnkey.votes.length, 0, "nothing is decided before the reviewer acts");
    const opened = t.events.filter((e) => e.type === "review_opened").map((e) => e.data.reviewId as string);
    assert.equal(opened.length, 2);
    await t.review(opened[0]!, "approve");
    await t.review(opened[1]!, "deny");
    await t.approver.poll();
    const decided = t.turnkey.votes.map((v): [string, string] => [v.kind, v.fingerprint]).sort();
    assert.deepEqual(decided, [["APPROVE", approved.fingerprint], ["REJECT", denied.fingerprint]]);
  } finally {
    await t.close();
  }
});

test("Turnkey sending a transaction itself, on a guarded wallet, is rejected", async () => {
  const t = await setup();
  try {
    const send = signingRequest(t.wallet, t.vendor, "ACTIVITY_TYPE_SOL_SEND_TRANSACTION_V2");
    t.turnkey.activities.set(send.id, send);
    await t.approver.poll();
    assert.deepEqual(t.turnkey.votes, [{ kind: "REJECT", fingerprint: send.fingerprint }]);
    assert.match(String(t.events.find((e) => e.type === "turnkey_rejected")?.data.reason), /not a Solana signature/);
  } finally {
    await t.close();
  }
});

test("when Turnkey refuses the approval, the budget stays counted: a refusal does not prove nothing was signed", async () => {
  const t = await setup({ approveStatus: 400 });
  try {
    // The demo policy allows 5 SOL a day; this takes 0.1 SOL each time it is reserved. Refused votes keep their
    // charge, so after 50 the day's limit is reached and the rest go to a person: conservative, may overcount.
    for (let i = 0; i < 60; i++) {
      const request = signingRequest(t.wallet, t.vendor);
      t.turnkey.activities.set(request.id, request);
      await t.approver.poll();
      t.turnkey.activities.delete(request.id);
    }
    const refused = t.events.filter((e) => e.type === "turnkey_failed");
    assert.equal(refused.length, 50);
    assert.ok(refused.every((e) => e.data.outcome === "REFUSED" && e.data.accountingRetained === true));
    assert.equal(t.events.filter((e) => e.type === "review_opened").length, 10, "the retained charges count against the daily limit");
    assert.equal(t.turnkey.badStamps(), 0);
  } finally {
    await t.close();
  }
});

test("a Turnkey webhook only triggers a poll", async () => {
  const t = await setup();
  try {
    const ok = signingRequest(t.wallet, t.vendor);
    t.turnkey.activities.set(ok.id, ok);
    const r = await fetch(`${t.base}/turnkey/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ forged: "anything" }) });
    assert.equal(r.status, 202);
    await t.approver.poll();
    assert.deepEqual(t.turnkey.votes, [{ kind: "APPROVE", fingerprint: ok.fingerprint }]);
  } finally {
    await t.close();
  }
});

test("the policy template needs both approvers for one wallet and refuses unsafe input", async () => {
  const { turnkeyGuardPolicies } = await import("../src/turnkey/policy-template.js");
  const agent = "11111111-2222-4333-8444-555555555555", guard = "66666666-7777-4888-9999-000000000000";
  const wallet = Keypair.generate().publicKey.toBase58();
  const [sign, noExport] = turnkeyGuardPolicies({ agentUserId: agent, agentGuardUserId: guard, walletAddress: wallet, label: "range-finder" });
  assert.equal(sign!.consensus, `approvers.any(user, user.id == '${agent}') && approvers.any(user, user.id == '${guard}')`);
  assert.match(sign!.condition, new RegExp(`wallet_account.address == '${wallet}'`));
  assert.equal(noExport!.effect, "EFFECT_DENY");
  assert.throws(() => turnkeyGuardPolicies({ agentUserId: agent, agentGuardUserId: agent, walletAddress: wallet, label: "x" }), /different Turnkey users/);
  assert.throws(() => turnkeyGuardPolicies({ agentUserId: "x' || true || '", agentGuardUserId: guard, walletAddress: wallet, label: "x" }), /UUID/);
  assert.throws(() => turnkeyGuardPolicies({ agentUserId: agent, agentGuardUserId: guard, walletAddress: `${wallet}' || true`, label: "x" }), /base58/);
});

test("Turnkey settings are all or nothing, and wallets are validated", async () => {
  const { turnkeyConfigFromEnv } = await import("../src/turnkey/config.js");
  const key = apiKey();
  const wallet = Keypair.generate().publicKey.toBase58();
  const env = { TURNKEY_ORGANIZATION_ID: "org", TURNKEY_API_PUBLIC_KEY: key.publicKey, TURNKEY_API_PRIVATE_KEY: key.privateKey, TURNKEY_WALLETS: JSON.stringify({ [wallet]: { policyId: "p", agentId: "a" } }) };
  assert.equal(turnkeyConfigFromEnv({}), undefined);
  assert.deepEqual(Object.keys(turnkeyConfigFromEnv(env)!.wallets), [wallet]);
  assert.throws(() => turnkeyConfigFromEnv({ ...env, TURNKEY_WALLETS: undefined }), /needs all of/);
  assert.throws(() => turnkeyConfigFromEnv({ ...env, TURNKEY_WALLETS: JSON.stringify({ "not-an-address": { policyId: "p", agentId: "a" } }) }), /invalid Solana address/);
  assert.throws(() => turnkeyConfigFromEnv({ ...env, TURNKEY_API_PUBLIC_KEY: apiKey().publicKey }), /does not belong/);
});

test("a guarded request is found even when more than one page of other waiting requests comes first", async () => {
  const t = await setup();
  try {
    // 150 waiting requests for wallets AgentGuard does not guard, then one for the guarded wallet.
    for (let i = 0; i < 150; i++) { const other = signingRequest(Keypair.generate().publicKey, t.vendor); t.turnkey.activities.set(other.id, other); }
    const ours = signingRequest(t.wallet, t.vendor);
    t.turnkey.activities.set(ours.id, ours);
    await t.approver.poll();
    assert.deepEqual(t.turnkey.votes, [{ kind: "APPROVE", fingerprint: ours.fingerprint }]);
  } finally {
    await t.close();
  }
});

/** Turnkey's list call over `total` waiting activities, as a fetch stand-in; `pageSize` overrides the requested limit. */
function listingFetch(total: number, pageSize?: number) {
  const all = Array.from({ length: total }, (_, i) => ({ id: `a${i}`, organizationId: "org", status: "ACTIVITY_STATUS_CONSENSUS_NEEDED", type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", fingerprint: `f${i}`, intent: {} }));
  let calls = 0;
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const limit = pageSize ?? Number(body.paginationOptions.limit);
    const start = body.paginationOptions.after ? all.findIndex((a) => a.id === body.paginationOptions.after) + 1 : 0;
    return new Response(JSON.stringify({ activities: all.slice(start, start + limit) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

test("a waiting list longer than one call can read is finished on the next call", async () => {
  const key = apiKey();
  const listing = listingFetch(2_001);
  const api = turnkeyHttpApi({ organizationId: "org", apiPublicKey: key.publicKey, apiPrivateKey: key.privateKey, fetchImpl: listing.fetchImpl });
  const first = await api.listWaitingActivities();
  assert.equal(first.length, 2_000);
  assert.equal(listing.calls(), 20, "one call reads at most 20 pages");
  const second = await api.listWaitingActivities();
  assert.deepEqual(second.map((a) => a.id), ["a2000"], "the next call carries on where the last stopped");
  const third = await api.listWaitingActivities();
  assert.equal(third.length, 2_000, "after reaching the end it starts again from the first page");
});

test("a short page does not end the list, in case Turnkey ignores the requested limit", async () => {
  const key = apiKey();
  const listing = listingFetch(35, 10);
  const api = turnkeyHttpApi({ organizationId: "org", apiPublicKey: key.publicKey, apiPrivateKey: key.privateKey, fetchImpl: listing.fetchImpl });
  assert.equal((await api.listWaitingActivities()).length, 35);
});

test("a guarded request behind more than 2,000 others is found on a later poll, and its approved review is acted on without waiting for the scan to come round again", async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 2_001; i++) { const other = signingRequest(Keypair.generate().publicKey, t.vendor); t.turnkey.activities.set(other.id, other); }
    const ours = signingRequest(t.wallet, Keypair.generate().publicKey); // not a vendor: goes to review
    t.turnkey.activities.set(ours.id, ours);
    await t.approver.poll();
    assert.ok(!t.events.some((e) => e.type === "turnkey_review_linked"), "the first poll stops at the page cap");
    assert.equal(t.approver.status().lastScan?.complete, false);
    await t.approver.poll();
    const linked = t.events.find((e) => e.type === "turnkey_review_linked");
    assert.ok(linked, "the second poll carries on and reaches it");
    assert.equal(t.approver.status().lastScan?.complete, true);
    // The next scan starts from the top again and would not reach it this poll; the decision is still acted on.
    await t.review(String(linked!.data.reviewId), "approve");
    await t.approver.poll();
    assert.deepEqual(t.turnkey.votes, [{ kind: "APPROVE", fingerprint: ours.fingerprint }]);
    const health = await (await fetch(`${t.base}/healthz`)).json() as any;
    assert.equal(health.turnkey.consecutivePaginationFailures, 0);
    assert.ok(health.turnkey.lastSuccessfulPollAt && health.turnkey.lastCompleteScanAt);
  } finally {
    await t.close();
  }
});

test("turnkey: an approval is void once the wallet's policy rules change, so the request is rejected, not signed", async () => {
  const t = await setup();
  try {
    const ours = signingRequest(t.wallet, Keypair.generate().publicKey);
    t.turnkey.activities.set(ours.id, ours);
    await t.approver.poll();
    const linked = t.events.find((e) => e.type === "turnkey_review_linked")!;
    const original = t.policies.get("demo")!;
    t.policies.set("demo", { ...original, maxAmountPerDay: { ...original.maxAmountPerDay, native: "999999999999" } });
    await t.review(String(linked.data.reviewId), "approve");
    await t.approver.poll();
    assert.deepEqual(t.turnkey.votes, [{ kind: "REJECT", fingerprint: ours.fingerprint }]);
    assert.ok(t.events.some((e) => e.type === "approval_refused" && e.data.reason === "policy_changed"));
  } finally {
    await t.close();
  }
});

test("turnkey: after a restart the recorded review is reused, not opened again, and its approval is acted on once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-turnkey-"));
  const persistencePath = join(dir, "db.sqlite");
  const first = await setup({ persistencePath });
  try {
    const ours = signingRequest(first.wallet, Keypair.generate().publicKey);
    first.turnkey.activities.set(ours.id, ours);
    await first.approver.poll();
    await first.approver.poll(); // a repeated poll
    await fetch(`${first.base}/turnkey/webhook`, { method: "POST" }); // and a webhook
    await first.approver.poll();
    assert.equal(first.events.filter((e) => e.type === "review_opened").length, 1, "one review however often it is seen");
    const reviewId = String(first.events.find((e) => e.type === "turnkey_review_linked")!.data.reviewId);
    await first.closeServer();

    const second = await setup({ persistencePath, reuse: { key: first.key, turnkey: first.turnkey, wallet: first.wallet, vendor: first.vendor } });
    try {
      await second.approver.poll();
      assert.equal(second.events.filter((e) => e.type === "review_opened").length, 0, "the restarted server does not open another");
      await second.review(reviewId, "approve");
      await second.approver.poll();
      await second.approver.poll();
      assert.deepEqual(first.turnkey.votes, [{ kind: "APPROVE", fingerprint: ours.fingerprint }], "one vote");
    } finally { await second.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** A lifecycle store that "crashes" (throws) on the first write matching `when`: everything before it happened, nothing after. */
class CrashingLifecycle extends TurnkeyLifecycleStore {
  constructor(path: string, private when?: (update: ActivityUpdate) => boolean) { super({ persistencePath: path }); }
  override update(organizationId: string, activityId: string, update: ActivityUpdate): void {
    if (this.when?.(update)) { this.when = undefined; throw new Error("injected crash"); }
    super.update(organizationId, activityId, update);
  }
}

/** Runs one activity up to an injected crash, then restarts on the same database and recovers it, three times over. */
async function crashAndRecover(options: { crashWhen: (update: ActivityUpdate) => boolean; approveStatus?: number; toVendor: boolean; beforeCrash?: (t: Awaited<ReturnType<typeof setup>>, activity: TurnkeyActivity, path: string) => Promise<void>; beforeRestart?: (t: Awaited<ReturnType<typeof setup>>, activity: TurnkeyActivity, path: string) => void; restart?: { assignment?: Partial<GuardedWallet>; editPolicy?: (policy: Policy) => Policy } }) {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-crash-"));
  const path = join(dir, "db.sqlite");
  const first = await setup({ persistencePath: path, approveStatus: options.approveStatus, lifecycle: new CrashingLifecycle(path, options.crashWhen) });
  const policyId = first.policies.get("demo")!.policyId;
  new DailySpendTracker({ persistencePath: path }).record(policyId, { native: 7n }); // other spending today, which no refund may touch
  const ours = signingRequest(first.wallet, options.toVendor ? first.vendor : Keypair.generate().publicKey);
  first.turnkey.activities.set(ours.id, ours);
  await options.beforeCrash?.(first, ours, path);
  await first.approver.poll(); // runs into the crash
  await first.closeServer();
  options.beforeRestart?.(first, ours, path);
  const reboot = () => setup({ persistencePath: path, ...options.restart, reuse: { key: first.key, turnkey: first.turnkey, wallet: first.wallet, vendor: first.vendor } });
  const restarts = [];
  for (let i = 0; i < 3; i++) { const t = await reboot(); await t.approver.poll(); await t.approver.poll(); restarts.push(t); await t.closeServer(); }
  const db = openSqliteDatabase(path);
  const spent = BigInt((db.prepare("SELECT amount FROM daily_spend WHERE policy_id = ? AND asset = 'native'").get(policyId) as { amount: string }).amount);
  const reviews = (db.prepare("SELECT COUNT(*) AS n FROM pending_reviews").get() as { n: number }).n;
  const record = new TurnkeyLifecycleStore({ persistencePath: path }).get("org", ours.id)!;
  const evaluatedAfterRestart = restarts.reduce((n, t) => n + t.events.filter((e) => e.type === "evaluated").length, 0);
  await first.turnkey.close();
  rmSync(dir, { recursive: true, force: true });
  const events = [first, ...restarts].flatMap((t) => t.events);
  return { ours, votes: first.turnkey.votes, spent, reviews, record, evaluatedAfterRestart, first, events };
}

/** Opens the review and approves it, so the next poll spends the approval and charges before saving VOTING. */
async function approveBeforeCrash(t: Awaited<ReturnType<typeof setup>>) {
  await t.approver.poll();
  await t.review(String(t.events.find((e) => e.type === "turnkey_review_linked")!.data.reviewId), "approve");
}
const LAMPORTS = 100_000_000n; // what signingRequest transfers

test("crash after an ALLOW charged the budget but before VOTING was saved: recovered with one charge and one vote", async () => {
  const r = await crashAndRecover({ toVendor: true, crashWhen: (u) => u.state === "VOTING" });
  assert.deepEqual(r.votes, [{ kind: "APPROVE", fingerprint: r.ours.fingerprint }]);
  assert.equal(r.spent, 7n + LAMPORTS, "charged once");
  assert.equal(r.evaluatedAfterRestart, 0, "the held charge is used, not a new check");
  assert.equal(r.record.voteActivityStatus, "ACTIVITY_STATUS_COMPLETED");
  assert.equal(r.record.state, "SIGNING_COMPLETED", "the vote completed, then the signing request was seen completed");
});

test("crash after a review was opened but before it was linked: recovery finds that review instead of opening another", async () => {
  const r = await crashAndRecover({ toVendor: false, crashWhen: (u) => u.state === "REVIEW_OPEN" });
  assert.equal(r.reviews, 1, "one review in the database");
  assert.equal(r.record.state, "REVIEW_OPEN");
  assert.equal(r.first.events.filter((e) => e.type === "review_opened").length, 1);
  assert.equal(r.votes.length, 0);
});

test("crash after an approval was spent and charged but before VOTING was saved: recovered with one charge and one vote", async () => {
  const r = await crashAndRecover({
    toVendor: false,
    crashWhen: (u) => u.state === "VOTING",
    beforeCrash: async (t) => {
      await t.approver.poll(); // opens the review (no crash: REVIEW_OPEN is not the trigger)
      const reviewId = String(t.events.find((e) => e.type === "turnkey_review_linked")!.data.reviewId);
      // Approve without the immediate poll the review route triggers racing the test: decide, then let poll() run.
      await t.review(reviewId, "approve");
    }
  });
  assert.deepEqual(r.votes, [{ kind: "APPROVE", fingerprint: r.ours.fingerprint }]);
  assert.equal(r.spent, 7n + LAMPORTS, "charged once");
  assert.equal(r.reviews, 1);
  assert.equal(r.record.voteActivityStatus, "ACTIVITY_STATUS_COMPLETED");
  assert.equal(r.record.state, "SIGNING_COMPLETED");
});

test("an activity Turnkey rejects after an unknown vote keeps its charge, across a crash while recording it", async () => {
  const r = await crashAndRecover({
    toVendor: true,
    approveStatus: 503, // the vote's outcome is unknown
    crashWhen: (u) => u.state === "RESOLVED_EXTERNALLY",
    beforeCrash: async (t, activity) => {
      await t.approver.poll();
      activity.status = "ACTIVITY_STATUS_REJECTED"; // Turnkey then rejects it
    }
  });
  assert.equal(r.spent, 7n + LAMPORTS, "REJECTED does not prove no signature: kept; other spending untouched");
  assert.equal(r.record.state, "RESOLVED_EXTERNALLY");
});

test("a refused first vote keeps its charge across restarts and is not voted on again", async () => {
  const r = await crashAndRecover({ toVendor: true, approveStatus: 400, crashWhen: () => false });
  assert.equal(r.spent, 7n + LAMPORTS, "kept; other spending untouched");
  assert.equal(r.record.state, "VOTE_REFUSED");
  assert.ok(r.record.reservation, "the record still names the kept charge");
  assert.equal(r.first.turnkey.requests.filter((q) => q.url.endsWith("/approve_activity")).length, 1, "one approve request, before the restarts");
});

test("crash before a refused vote was recorded: the charge is kept, never refunded below other spending", async () => {
  const r = await crashAndRecover({ toVendor: true, approveStatus: 400, crashWhen: (u) => u.state === "VOTE_REFUSED" });
  assert.equal(r.record.state, "VOTE_UNKNOWN", "a refusal of the repeat vote may mean the first counted");
  assert.equal(r.spent, 7n + LAMPORTS);
});

test("crash after an approval was spent, then a restart with the wallet assigned to another agent: no approve vote is sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-reassign-"));
  const path = join(dir, "db.sqlite");
  const first = await setup({ persistencePath: path, lifecycle: new CrashingLifecycle(path, (u) => u.state === "VOTING") });
  let second: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const ours = signingRequest(first.wallet, Keypair.generate().publicKey);
    first.turnkey.activities.set(ours.id, ours);
    await first.approver.poll();
    const reviewId = String(first.events.find((e) => e.type === "turnkey_review_linked")!.data.reviewId);
    openSqliteDatabase(path).prepare("UPDATE pending_reviews SET status = 'APPROVED', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), reviewId);
    await first.approver.poll(); // spends the approval, charges, then crashes before VOTING
    assert.equal(new TurnkeyLifecycleStore({ persistencePath: path }).get("org", ours.id)!.state, "REVIEW_OPEN");
    assert.equal(first.turnkey.votes.length, 0);
    await first.closeServer();
    second = await setup({ persistencePath: path, assignment: { agentId: "replacement-agent" }, reuse: { key: first.key, turnkey: first.turnkey, wallet: first.wallet, vendor: first.vendor } });
    await second.approver.poll();
    assert.deepEqual(first.turnkey.votes, [{ kind: "REJECT", fingerprint: ours.fingerprint }], "rejected, never approved");
    assert.equal(new TurnkeyLifecycleStore({ persistencePath: path }).get("org", ours.id)!.state, "MISMATCH");
    assert.ok(second.events.some((e) => e.type === "turnkey_rejected" && e.data.code === "ASSIGNMENT_CHANGED"));
  } finally {
    if (second) await second.closeServer();
    await first.turnkey.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** What every recovery refused for its assignment or approval must look like: rejected, never approved, budget back. */
function assertRefusedBeforeVote(r: Awaited<ReturnType<typeof crashAndRecover>>, code: string, state: "MISMATCH" | "REJECTED") {
  assert.deepEqual(r.votes, [{ kind: "REJECT", fingerprint: r.ours.fingerprint }], "rejected once, never approved");
  assert.equal(r.record.state, state);
  assert.match(r.record.detail ?? "", new RegExp(`^${code}: `), "the record carries the code");
  assert.ok(r.events.some((e) => e.type === "turnkey_rejected" && e.data.code === code), "the audit event carries the code");
  assert.equal(r.spent, 7n, "no vote went out, so the activity's charge was refunded; other spending untouched");
}

for (const [what, assignment] of [["agent", { agentId: "replacement-agent" }], ["customer", { customerId: "another-customer" }], ["policy", { policyId: "demo-copy" }]] as const) {
  test(`crash after an approval was spent, then the wallet is reassigned to another ${what}: rejected, the approval and charge are not carried over`, async () => {
    const r = await crashAndRecover({ toVendor: false, crashWhen: (u) => u.state === "VOTING", beforeCrash: approveBeforeCrash, restart: { assignment } });
    assertRefusedBeforeVote(r, "ASSIGNMENT_CHANGED", "MISMATCH");
  });
}

test("crash after an ALLOW charged the budget, then the wallet is reassigned: rejected and the charge refunded, not voted on", async () => {
  const r = await crashAndRecover({ toVendor: true, crashWhen: (u) => u.state === "VOTING", restart: { assignment: { agentId: "replacement-agent" } } });
  assertRefusedBeforeVote(r, "ASSIGNMENT_CHANGED", "MISMATCH");
  assert.equal(r.evaluatedAfterRestart, 0, "not checked again under the new assignment");
});

test("crash after an approval was spent, then the policy's rules change: rejected, not voted on", async () => {
  const r = await crashAndRecover({
    toVendor: false, crashWhen: (u) => u.state === "VOTING", beforeCrash: approveBeforeCrash,
    restart: { editPolicy: (p) => ({ ...p, maxAmountPerDay: { ...p.maxAmountPerDay, native: "999999999999" } }) }
  });
  assertRefusedBeforeVote(r, "APPROVAL_POLICY_CHANGED", "REJECTED");
});

/** Opens the review, then sets its row directly (no route, so no poll races the test) and holds a charge under the activity's key. */
async function heldChargeWithReview(t: Awaited<ReturnType<typeof setup>>, activity: TurnkeyActivity, path: string, set: string) {
  await t.approver.poll();
  const reviewId = String(t.events.find((e) => e.type === "turnkey_review_linked")!.data.reviewId);
  openSqliteDatabase(path).prepare(`UPDATE pending_reviews SET status = 'APPROVED', resolved_at = ?, ${set} WHERE id = ?`).run(new Date().toISOString(), reviewId);
  new DailySpendTracker({ persistencePath: path }).record(t.policies.get("demo")!.policyId, { native: LAMPORTS }, `turnkey:org:${activity.id}`);
}

test("a held charge does not stand in for an approval that fails its checks", async () => {
  const r = await crashAndRecover({ toVendor: false, crashWhen: () => false, beforeCrash: (t, a, path) => heldChargeWithReview(t, a, path, "policy_fingerprint = 'other-rules'") });
  assertRefusedBeforeVote(r, "APPROVAL_POLICY_CHANGED", "REJECTED");
});

for (const [what, by] of [["another activity", "'turnkey:org:another-activity'"], ["another path, or before spenders were recorded", "NULL"]] as const) {
  test(`an approval spent by ${what} is not recovered by this activity, even with a charge held under its key`, async () => {
    const r = await crashAndRecover({ toVendor: false, crashWhen: () => false, beforeCrash: (t, a, path) => heldChargeWithReview(t, a, path, `consumed_at = '2026-01-01T00:00:00.000Z', consumed_by = ${by}`) });
    assertRefusedBeforeVote(r, "APPROVAL_CONSUMED_ELSEWHERE", "REJECTED");
  });
}

test("crash after an approval was spent, restarted after the approval went stale and before any vote: rejected, charge refunded", async () => {
  const r = await crashAndRecover({
    toVendor: false, crashWhen: (u) => u.state === "VOTING", beforeCrash: approveBeforeCrash,
    beforeRestart: (_t, _a, path) => { openSqliteDatabase(path).prepare("UPDATE pending_reviews SET resolved_at = ?").run(new Date(Date.now() - 60 * 60_000).toISOString()); }
  });
  assertRefusedBeforeVote(r, "APPROVAL_STALE", "REJECTED");
});

test("an approve vote with an unknown outcome is retried after its review goes stale, never refunded or rejected for that", async () => {
  const r = await crashAndRecover({
    toVendor: false, approveStatus: 503, crashWhen: () => false, beforeCrash: approveBeforeCrash,
    beforeRestart: (_t, _a, path) => { openSqliteDatabase(path).prepare("UPDATE pending_reviews SET resolved_at = ?").run(new Date(Date.now() - 60 * 60_000).toISOString()); }
  });
  assert.equal(r.record.state, "VOTE_UNKNOWN");
  assert.deepEqual(r.votes, [], "no reject; every approve attempt answered 503");
  assert.equal(r.spent, 7n + LAMPORTS, "the charge is kept while the vote may have counted");
});

test("an approve vote with an unknown outcome, then the wallet is reassigned: rejected, and the charge is kept", async () => {
  const r = await crashAndRecover({ toVendor: false, approveStatus: 503, crashWhen: () => false, beforeCrash: approveBeforeCrash, restart: { assignment: { agentId: "replacement-agent" } } });
  assert.deepEqual(r.votes, [{ kind: "REJECT", fingerprint: r.ours.fingerprint }]);
  assert.equal(r.record.state, "MISMATCH");
  assert.ok(r.events.some((e) => e.type === "turnkey_rejected" && e.data.code === "ASSIGNMENT_CHANGED"));
  assert.equal(r.spent, 7n + LAMPORTS, "the first vote may have counted, so the charge stays");
});

test("an approve vote answered with HTTP 200 but a FAILED vote activity is not taken as accepted; a new vote follows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-vote-status-"));
  const path = join(dir, "db.sqlite");
  const t = await setup({ persistencePath: path });
  try {
    const policyId = t.policies.get("demo")!.policyId;
    const ours = signingRequest(t.wallet, t.vendor);
    t.turnkey.activities.set(ours.id, ours);
    t.turnkey.control.voteStatus = "ACTIVITY_STATUS_FAILED";
    await t.approver.poll();
    const record = () => new TurnkeyLifecycleStore({ persistencePath: path }).get("org", ours.id)!;
    const spent = () => BigInt((openSqliteDatabase(path).prepare("SELECT amount FROM daily_spend WHERE policy_id = ? AND asset = 'native'").get(policyId) as { amount: string }).amount);
    assert.equal(ours.status, "ACTIVITY_STATUS_CONSENSUS_NEEDED", "the request still waits: the vote did not complete");
    assert.equal(record().state, "VOTE_UNKNOWN", "not recorded as an accepted vote");
    assert.match(record().detail ?? "", /^VOTE_NOT_COMPLETED: /);
    assert.equal(spent(), LAMPORTS, "the charge is kept while the vote's effect is unknown");
    assert.ok(!t.events.some((e) => e.type === "turnkey_approved"));
    t.turnkey.control.voteStatus = "ACTIVITY_STATUS_COMPLETED";
    await t.approver.poll(); // a failed vote activity cannot be replayed into success: a new request is sent
    assert.equal(record().state, "APPROVED");
    assert.equal(record().voteSubmissions, 2);
    assert.equal(spent(), LAMPORTS, "charged once");
  } finally { await t.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a reject vote answered with HTTP 200 but a FAILED vote activity is retried, not recorded as rejected", async () => {
  const t = await setup();
  try {
    const ours = signingRequest(t.wallet, t.vendor, "ACTIVITY_TYPE_SOL_SEND_TRANSACTION_V2"); // always rejected: Turnkey builds it
    t.turnkey.activities.set(ours.id, ours);
    t.turnkey.control.voteStatus = "ACTIVITY_STATUS_FAILED";
    await t.approver.poll();
    assert.equal(ours.status, "ACTIVITY_STATUS_CONSENSUS_NEEDED");
    assert.ok(!t.events.some((e) => e.type === "turnkey_rejected"), "not reported as rejected");
    t.turnkey.control.voteStatus = "ACTIVITY_STATUS_COMPLETED";
    await t.approver.poll();
    assert.equal(ours.status, "ACTIVITY_STATUS_REJECTED");
    assert.ok(t.events.some((e) => e.type === "turnkey_rejected"));
  } finally { await t.close(); }
});

// ---- Outcome handling: no refund on an external answer, and pending vote activities reconciled ----

/** A server on SQLite with a clock the test moves; backoff as given (zero unless a test sets it). */
async function outcomeWorld(options: { approveStatus?: number; retry?: Partial<TurnkeyRetryPolicy> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-outcome-"));
  const path = join(dir, "db.sqlite");
  const clock = { now: Date.UTC(2026, 10, 10, 12, 0, 0) };
  const boot = (reuse?: Awaited<ReturnType<typeof setup>>) => setup({ persistencePath: path, approveStatus: options.approveStatus, retry: options.retry, now: () => clock.now,
    ...(reuse ? { reuse: { key: reuse.key, turnkey: reuse.turnkey, wallet: reuse.wallet, vendor: reuse.vendor } } : {}) });
  const t = await boot();
  const policyId = t.policies.get("demo")!.policyId;
  return {
    t, path, clock, boot,
    record: (id: string) => new TurnkeyLifecycleStore({ persistencePath: path }).get("org", id)!,
    spent: () => BigInt((openSqliteDatabase(path).prepare("SELECT amount FROM daily_spend WHERE policy_id = ? AND asset = 'native'").get(policyId) as { amount: string } | undefined)?.amount ?? "0"),
    approveRequests: () => t.turnkey.requests.filter((q) => q.url.endsWith("/approve_activity")).length,
    voteQueries: () => t.turnkey.requests.filter((q) => q.url.endsWith("/get_activity") && q.activityId?.startsWith("vote-")).length,
    close: async () => { await t.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test("outcome: the signing request completes through another approver before our first vote gets a 4xx: the charge is not refunded", async () => {
  const w = await outcomeWorld({ approveStatus: 400 });
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.beforeVote = () => { ours.status = "ACTIVITY_STATUS_COMPLETED"; }; // a root user approved first
    await w.t.approver.poll();
    assert.equal(w.spent(), LAMPORTS, "the transaction was signed: its charge stays");
    assert.equal(w.record(ours.id).state, "SIGNING_COMPLETED", "the re-read shows what happened");
    assert.match(w.record(ours.id).detail ?? "", /ACCOUNTING_RETAINED/);
  } finally { await w.close(); }
});

test("outcome: a 4xx on the first vote followed by a failed status lookup keeps the charge", async () => {
  const w = await outcomeWorld({ approveStatus: 403 });
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.failReadsNext = 1;
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "VOTE_REFUSED");
    assert.equal(w.spent(), LAMPORTS, "nothing proves no signature can follow: kept");
  } finally { await w.close(); }
});

test("outcome: a pending vote activity is queried until it completes: one vote request, several status queries, one charge, across a restart", async () => {
  const w = await outcomeWorld();
  let second: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.voteStatus = "ACTIVITY_STATUS_PENDING";
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "VOTE_PENDING");
    const voteId = w.record(ours.id).voteActivityId!;
    assert.match(voteId, /^vote-/, "the vote activity's own id is kept, apart from the signing activity's");
    assert.notEqual(voteId, ours.id);
    await w.t.approver.poll();
    await w.t.approver.poll();
    await w.t.closeServer();
    second = await w.boot(w.t); // restart while the vote is pending
    await second.approver.poll();
    assert.equal(w.approveRequests(), 1, "no new vote while the recorded one is pending");
    assert.ok(w.voteQueries() >= 3, `the vote activity was queried (${w.voteQueries()} times)`);
    w.t.turnkey.settleVote(voteId, "ACTIVITY_STATUS_COMPLETED");
    await second.approver.poll();
    assert.equal(w.record(ours.id).state, "SIGNING_COMPLETED");
    assert.equal(w.spent(), LAMPORTS, "charged once");
    assert.equal(w.t.turnkey.votes.length, 1, "one vote activity");
  } finally { if (second) await second.closeServer(); await w.close(); }
});

test("outcome: a signing request that Turnkey finishes while its vote is pending is recorded, and the vote is not queried again", async () => {
  const w = await outcomeWorld();
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.voteStatus = "ACTIVITY_STATUS_PENDING";
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "VOTE_PENDING");
    ours.status = "ACTIVITY_STATUS_REJECTED"; // rejected by another approver
    const queries = w.voteQueries();
    await w.t.approver.poll();
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "RESOLVED_EXTERNALLY");
    assert.equal(w.voteQueries(), queries, "the finished signing request ends the reconciliation");
    assert.equal(w.spent(), LAMPORTS, "kept: REJECTED does not prove no signature");
  } finally { await w.close(); }
});

for (const answer of ["missing", "malformed"] as const) {
  test(`outcome: a ${answer} answer to a vote leaves the outcome unknown; the identical request is replayed and Turnkey returns the one vote activity`, async () => {
    const w = await outcomeWorld();
    try {
      const ours = signingRequest(w.t.wallet, w.t.vendor);
      w.t.turnkey.activities.set(ours.id, ours);
      w.t.turnkey.control.voteStatus = "ACTIVITY_STATUS_PENDING";
      w.t.turnkey.control.voteAnswer = answer;
      await w.t.approver.poll();
      assert.equal(w.record(ours.id).state, "VOTE_UNKNOWN");
      assert.match(w.record(ours.id).detail ?? "", answer === "missing" ? /^VOTE_NO_ACTIVITY_ID: / : /^VOTE_OUTCOME_UNKNOWN: /);
      assert.equal(w.spent(), LAMPORTS);
      w.t.turnkey.control.voteAnswer = "normal";
      await w.t.approver.poll();
      assert.equal(w.record(ours.id).state, "VOTE_PENDING", "the replay named the vote activity");
      assert.equal(w.t.turnkey.votes.length, 1, "one vote activity for both requests");
      assert.equal(w.record(ours.id).voteSubmissions, 1, "one distinct request");
    } finally { await w.close(); }
  });
}

test("outcome: rate limits back off exponentially from AgentGuard's own schedule (Turnkey sends no Retry-After), replaying one request", async () => {
  const w = await outcomeWorld({ retry: { baseDelayMs: 1_000, maxDelayMs: 4_000 } });
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.rateLimitVotesNext = 4;
    const waits: number[] = [];
    await w.t.approver.poll();
    for (let i = 0; i < 4; i++) {
      const before = w.approveRequests();
      await w.t.approver.poll(); // not yet due: nothing is sent
      assert.equal(w.approveRequests(), before, "no request before the backoff ends");
      const wait = Date.parse(w.record(ours.id).nextCheckAt!) - w.clock.now;
      waits.push(wait);
      w.clock.now += wait;
      await w.t.approver.poll();
    }
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 4_000], "doubling, capped at maxDelayMs");
    assert.equal(w.record(ours.id).state, "APPROVED");
    assert.equal(w.approveRequests(), 5);
    assert.equal(w.record(ours.id).voteSubmissions, 1, "every retry was the same request");
    assert.equal(w.spent(), LAMPORTS);
  } finally { await w.close(); }
});

test("outcome: after the replay window a new request is sent, and after maxVoteSubmissions AgentGuard only watches the signing request", async () => {
  const w = await outcomeWorld({ retry: { baseDelayMs: 0, maxDelayMs: 0, maxVoteSubmissions: 2, replayWindowMs: 60_000 } });
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.voteAnswer = "missing";
    w.t.turnkey.control.voteStatus = "ACTIVITY_STATUS_PENDING";
    await w.t.approver.poll();
    w.clock.now += 61_000; // the recorded request is too old to replay
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).voteSubmissions, 2, "a second, new request");
    w.clock.now += 61_000;
    await w.t.approver.poll();
    const record = w.record(ours.id);
    assert.equal(record.state, "VOTE_UNKNOWN");
    assert.match(record.detail ?? "", /^VOTE_ATTEMPTS_EXHAUSTED: .*ACCOUNTING_RETAINED/);
    const requests = w.approveRequests();
    w.clock.now += 61_000;
    await w.t.approver.poll();
    assert.equal(w.approveRequests(), requests, "no more vote requests");
    ours.status = "ACTIVITY_STATUS_COMPLETED"; // but the signing request is still watched
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "SIGNING_COMPLETED");
    assert.equal(w.spent(), LAMPORTS);
  } finally { await w.close(); }
});

test("outcome: a pending reject vote is queried, not sent again, until it completes", async () => {
  const w = await outcomeWorld();
  try {
    const ours = signingRequest(w.t.wallet, Keypair.generate().publicKey); // not on the allowlist: a person decides
    w.t.turnkey.activities.set(ours.id, ours);
    await w.t.approver.poll();
    const reviewId = String(w.t.events.find((e) => e.type === "turnkey_review_linked")!.data.reviewId);
    openSqliteDatabase(w.path).prepare("UPDATE pending_reviews SET status = 'DENIED', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), reviewId);
    w.t.turnkey.control.voteStatus = "ACTIVITY_STATUS_PENDING";
    await w.t.approver.poll();
    await w.t.approver.poll();
    await w.t.approver.poll();
    assert.equal(w.t.turnkey.requests.filter((q) => q.url.endsWith("/reject_activity")).length, 1, "one reject request while it is pending");
    assert.equal(w.record(ours.id).state, "REJECT_PENDING");
    assert.equal(w.record(ours.id).voteKind, "REJECT");
    w.t.turnkey.settleVote(w.record(ours.id).voteActivityId!, "ACTIVITY_STATUS_COMPLETED");
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "REJECTED");
  } finally { await w.close(); }
});

// ---- After the vote: the signing request is still watched, read only ----

/** Reads of the signing activity itself (not of vote activities). */
const signingReads = (w: Awaited<ReturnType<typeof outcomeWorld>>, id: string) => w.t.turnkey.requests.filter((q) => q.url.endsWith("/get_activity") && q.activityId === id).length;

for (const [ending, final] of [["ACTIVITY_STATUS_COMPLETED", "SIGNING_COMPLETED"], ["ACTIVITY_STATUS_FAILED", "RESOLVED_EXTERNALLY"], ["ACTIVITY_STATUS_REJECTED", "RESOLVED_EXTERNALLY"]] as const) {
  test(`after: a completed vote on a request still needing another approver is watched until it ends ${ending}, with no second vote`, async () => {
    const w = await outcomeWorld();
    try {
      const ours = signingRequest(w.t.wallet, w.t.vendor);
      w.t.turnkey.activities.set(ours.id, ours);
      w.t.turnkey.control.anotherApproverNeeded = true;
      await w.t.approver.poll();
      assert.equal(w.record(ours.id).state, "APPROVED", "the vote completed");
      assert.equal(ours.status, "ACTIVITY_STATUS_CONSENSUS_NEEDED", "the signing request still waits");
      for (let i = 0; i < 3; i++) await w.t.approver.poll();
      assert.ok(signingReads(w, ours.id) >= 3, "the signing request is read on later passes");
      assert.equal(w.approveRequests(), 1, "a completed vote is never sent again");
      ours.status = ending; // another approver acts, or Turnkey ends it
      await w.t.approver.poll();
      assert.equal(w.record(ours.id).state, final);
      assert.equal(w.approveRequests(), 1);
      assert.equal(w.spent(), LAMPORTS, "one charge, kept whatever the ending");
    } finally { await w.close(); }
  });
}

test("after: a restart between the completed vote and the signing request's completion keeps watching without voting again", async () => {
  const w = await outcomeWorld();
  let second: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.anotherApproverNeeded = true;
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "APPROVED");
    await w.t.closeServer();
    second = await w.boot(w.t);
    await second.approver.poll();
    assert.equal(w.record(ours.id).state, "APPROVED");
    ours.status = "ACTIVITY_STATUS_COMPLETED";
    await second.approver.poll();
    assert.equal(w.record(ours.id).state, "SIGNING_COMPLETED");
    assert.equal(w.approveRequests(), 1);
  } finally { if (second) await second.closeServer(); await w.close(); }
});

test("after: a refused first vote whose immediate re-read failed is still watched, and its later completion is recorded", async () => {
  const w = await outcomeWorld({ approveStatus: 400 });
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.failReadsNext = 1;
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "VOTE_REFUSED");
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "VOTE_REFUSED", "still waiting: still watched");
    ours.status = "ACTIVITY_STATUS_COMPLETED"; // completed through another approver
    await w.t.approver.poll();
    assert.equal(w.record(ours.id).state, "SIGNING_COMPLETED");
    assert.equal(w.approveRequests(), 1, "the refused vote is never sent again");
    assert.equal(w.spent(), LAMPORTS);
  } finally { await w.close(); }
});

test("after: watching backs off, and at the observation horizon the record is handed to an operator as SIGNING_UNRESOLVED", async () => {
  const w = await outcomeWorld({ retry: { baseDelayMs: 10_000, maxDelayMs: 10_000, watchHorizonMs: 60_000 } });
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.anotherApproverNeeded = true;
    await w.t.approver.poll();
    await w.t.approver.poll(); // first read after the vote; schedules the next
    const reads = signingReads(w, ours.id);
    await w.t.approver.poll();
    await w.t.approver.poll();
    assert.equal(signingReads(w, ours.id), reads, "no read before the backoff ends");
    w.clock.now += 61_000;
    await w.t.approver.poll();
    const record = w.record(ours.id);
    assert.equal(record.state, "SIGNING_UNRESOLVED");
    assert.match(record.detail ?? "", /^OBSERVATION_ENDED: .*Check the request in Turnkey/);
    const finalReads = signingReads(w, ours.id);
    w.clock.now += 61_000;
    await w.t.approver.poll();
    assert.equal(signingReads(w, ours.id), finalReads, "not read again");
    assert.equal(w.approveRequests(), 1);
    assert.equal(w.spent(), LAMPORTS, "the charge stays");
  } finally { await w.close(); }
});

// ---- Requests AgentGuard can only refuse: recorded before the reject is sent ----

/** A guarded-wallet request whose transaction bytes are not valid hex, so AgentGuard cannot read it. */
function unreadableRequest(wallet: PublicKey): TurnkeyActivity {
  const request = signingRequest(wallet, Keypair.generate().publicKey);
  request.intent.signTransactionIntentV2!.unsignedTransaction = "not-hex";
  return request;
}

test("reject-only: an unsupported request with rate-limited rejects is recorded first and backs off; polls at one time send one request", async () => {
  const w = await outcomeWorld({ retry: { baseDelayMs: 60_000, maxDelayMs: 60_000 } });
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor, "ACTIVITY_TYPE_SOL_SEND_TRANSACTION_V2");
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.rateLimitVotesNext = 10;
    for (let i = 0; i < 5; i++) await w.t.approver.poll();
    const rejects = () => w.t.turnkey.requests.filter((q) => q.url.endsWith("/reject_activity"));
    assert.equal(rejects().length, 1, "five polls at one clock time: one reject request");
    const record = w.record(ours.id);
    assert.deepEqual([record.purpose, record.state, record.transactionHash, record.voteKind], ["REJECT_ONLY", "REJECT_PENDING", undefined, "REJECT"]);
    assert.equal(record.wallet, w.t.wallet.toBase58());
    assert.equal(record.voteFingerprint, ours.fingerprint);
    assert.match(record.detail ?? "", /^UNSUPPORTED_ACTIVITY: /);
    assert.equal(Date.parse(record.nextCheckAt!) - w.clock.now, 60_000);
    w.clock.now += 60_000;
    await w.t.approver.poll();
    assert.equal(rejects().length, 2);
    assert.equal(rejects()[0]!.timestampMs, rejects()[1]!.timestampMs, "the same request, replayed");
    // Never the approval path: no check, no review, no charge.
    assert.ok(!w.t.events.some((e) => e.type === "evaluated" || e.type === "review_opened"));
    assert.equal(w.spent(), 0n);
    assert.equal(w.approveRequests(), 0);
  } finally { await w.close(); }
});

test("reject-only: an unreadable transaction's failed rejects are bounded by distinct requests, then only watched", async () => {
  const w = await outcomeWorld({ retry: { baseDelayMs: 0, maxDelayMs: 0, maxVoteSubmissions: 2 } });
  try {
    const ours = unreadableRequest(w.t.wallet);
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.voteStatus = "ACTIVITY_STATUS_FAILED"; // each reject vote activity fails
    for (let i = 0; i < 6; i++) await w.t.approver.poll();
    const rejects = w.t.turnkey.requests.filter((q) => q.url.endsWith("/reject_activity"));
    assert.equal(new Set(rejects.map((q) => q.timestampMs)).size, 2, "at most maxVoteSubmissions distinct reject requests");
    const record = w.record(ours.id);
    assert.equal(record.purpose, "REJECT_ONLY");
    assert.equal(record.transactionHash, undefined, "no transaction hash is invented");
    assert.match(record.detail ?? "", /^REJECT_ATTEMPTS_EXHAUSTED: /);
    assert.ok(signingReads(w, ours.id) > 0, "the signing request is still read");
    assert.equal(w.spent(), 0n);
  } finally { await w.close(); }
});

test("reject-only: a pending reject vote is queried by id, and a restart keeps the backoff and the request", async () => {
  const w = await outcomeWorld({ retry: { baseDelayMs: 30_000, maxDelayMs: 30_000 } });
  let second: Awaited<ReturnType<typeof setup>> | undefined;
  try {
    const ours = signingRequest(w.t.wallet, w.t.vendor, "ACTIVITY_TYPE_SOL_SEND_TRANSACTION_V2");
    w.t.turnkey.activities.set(ours.id, ours);
    w.t.turnkey.control.voteStatus = "ACTIVITY_STATUS_PENDING";
    await w.t.approver.poll();
    const before = w.record(ours.id);
    assert.ok(before.voteActivityId && before.voteTimestampMs && before.nextCheckAt);
    await w.t.closeServer();
    second = await w.boot(w.t); // restart, same clock
    await second.approver.poll();
    const rejects = () => w.t.turnkey.requests.filter((q) => q.url.endsWith("/reject_activity")).length;
    const voteReads = () => w.t.turnkey.requests.filter((q) => q.url.endsWith("/get_activity") && q.activityId === before.voteActivityId).length;
    assert.equal(rejects(), 1);
    assert.equal(voteReads(), 0, "the backoff survived the restart");
    w.clock.now += 30_000;
    await second.approver.poll();
    assert.equal(rejects(), 1, "the pending reject vote is queried, not sent again");
    assert.equal(voteReads(), 1);
    assert.equal(w.record(ours.id).voteTimestampMs, before.voteTimestampMs);
    w.t.turnkey.settleVote(before.voteActivityId!, "ACTIVITY_STATUS_COMPLETED");
    w.clock.now += 30_000;
    await second.approver.poll();
    assert.equal(w.record(ours.id).state, "REJECTED");
  } finally { if (second) await second.closeServer(); await w.close(); }
});


// ---- Turnkey tenant authorization: an explicitly scoped wallet whose customer is missing or revoked must fail closed ----

const DEMO_POLICY_ID = "property-maintenance-vendor-payments";

/**
 * A server whose single guarded wallet is scoped to a customer, with a matching server-wide policy under the same
 * id so the pre-fix global-policy fallback is reachable. `scenario` picks the wallet's customer: an active one, a
 * missing id, a revoked one, or none (intentionally unscoped). `toVendor` controls whether the request is ALLOWed
 * (vendor) or routed to human review (any other destination).
 */
async function tenantSetup(options: { scenario: "valid" | "missing" | "revoked" | "unscoped"; approveStatus?: number; resolveLookupTable?: (key: PublicKey) => Promise<AddressLookupTableAccount | null>; lifecycle?: (path: string) => TurnkeyLifecycleStore }) {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-tenant-"));
  const path = join(dir, "db.sqlite");
  const key = apiKey();
  const turnkey = await fakeTurnkey(key.publicKey, { approveStatus: options.approveStatus });
  const wallet = Keypair.generate().publicKey, vendor = Keypair.generate().publicKey;
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const customers = new CustomerStore({ persistencePath: path });
  const lifecycle = options.lifecycle?.(path);
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, buildDemoPolicy([vendor.toBase58()])); // the active customer owns the demo policy by its own id
  const customerId = options.scenario === "valid" || options.scenario === "revoked" ? acme.id
    : options.scenario === "missing" ? "00000000-0000-4000-8000-000000000000" : undefined;
  if (options.scenario === "revoked") assert.equal(customers.revoke(acme.id), true);
  const app = createServer(new Map([[DEMO_POLICY_ID, buildDemoPolicy([vendor.toBase58()])]]), buildDemoRegistry(), {
    baseUrl: "http://placeholder", reviewActionSecret: "t".repeat(40), persistencePath: path, customers,
    auditLog: { append: (_c: string | undefined, type: string, data: Record<string, unknown>) => { events.push({ type, data }); }, list: () => [], verify: () => ({ ok: true }) } as unknown as AuditLog,
    resolveLookupTable: options.resolveLookupTable,
    turnkey: { api: turnkeyHttpApi({ organizationId: "org", apiPublicKey: key.publicKey, apiPrivateKey: key.privateKey, baseUrl: turnkey.url }), wallets: { [wallet.toBase58()]: { policyId: DEMO_POLICY_ID, agentId: "turnkey-agent", customerId } }, autoStart: false, lifecycle, retry: { baseDelayMs: 0, maxDelayMs: 0 } }
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const approver = app.locals.turnkeyApprover as TurnkeyApprover;
  return {
    approver, turnkey, wallet, vendor, events, customers, acmeId: acme.id, base, path,
    record: (id: string) => new TurnkeyLifecycleStore({ persistencePath: path }).get("org", id),
    approveVotes: () => turnkey.votes.filter((v) => v.kind === "APPROVE").length,
    spent: () => BigInt((openSqliteDatabase(path).prepare("SELECT amount FROM daily_spend WHERE policy_id = ? AND asset = 'native'").get(DEMO_POLICY_ID) as { amount: string } | undefined)?.amount ?? "0"),
    review: (reviewId: string, action: "approve" | "deny") => fetch(`${base}/review/${reviewId}/${action}`, { method: "POST", headers: { "x-review-action-secret": "t".repeat(40) }, redirect: "manual" }),
    close: async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); await turnkey.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

for (const scenario of ["missing", "revoked"] as const) {
  test(`tenant: a ${scenario} Turnkey customer never authorizes an approve vote; the request is rejected, not approved`, async () => {
    const w = await tenantSetup({ scenario });
    try {
      const ours = signingRequest(w.wallet, w.vendor); // a transfer the demo policy would ALLOW under a valid tenant
      w.turnkey.activities.set(ours.id, ours);
      await w.approver.poll();
      assert.equal(w.approveVotes(), 0, "a missing or revoked customer must not produce an APPROVE vote");
      assert.equal(ours.status, "ACTIVITY_STATUS_REJECTED", "it is rejected, so it never resolves to the global policy");
      assert.equal(w.record(ours.id)!.state, "REJECTED");
      assert.equal(w.spent(), 0n, "nothing was charged for an unauthorized tenant");
    } finally { await w.close(); }
  });
}

test("tenant: an active customer is authorized, and an intentionally unscoped wallet still works", async () => {
  for (const scenario of ["valid", "unscoped"] as const) {
    const w = await tenantSetup({ scenario });
    try {
      const ours = signingRequest(w.wallet, w.vendor);
      w.turnkey.activities.set(ours.id, ours);
      await w.approver.poll();
      assert.deepEqual(w.turnkey.votes, [{ kind: "APPROVE", fingerprint: ours.fingerprint }], `${scenario} is approved`);
      assert.equal(w.record(ours.id)!.state, "APPROVED", `${scenario}: the approve vote completed`);
      await w.approver.poll(); // the watched signing request is then seen completed
      assert.equal(w.record(ours.id)!.state, "SIGNING_COMPLETED", scenario);
    } finally { await w.close(); }
  }
});

test("tenant: revocation after an ALLOW was evaluated and charged, before the vote completed, stops a new approve and keeps the charge", async () => {
  const w = await tenantSetup({ scenario: "valid", approveStatus: 503 }); // the first approve's outcome is unknown
  try {
    const ours = signingRequest(w.wallet, w.vendor);
    w.turnkey.activities.set(ours.id, ours);
    await w.approver.poll();
    assert.equal(w.record(ours.id)!.state, "VOTE_UNKNOWN", "one approve request went out with an unknown outcome");
    assert.equal(w.spent(), 100_000_000n, "charged once");
    const requestsBefore = w.turnkey.votes.length;
    assert.equal(w.customers.revoke(w.acmeId), true); // revoked while the vote outcome is unknown
    await w.approver.poll();
    assert.equal(w.turnkey.votes.length, requestsBefore, "no new vote request after revocation");
    assert.equal(w.approveVotes(), 0, "no APPROVE completed");
    assert.match(w.record(ours.id)!.detail ?? "", /TENANT_UNAUTHORIZED|VOTE/);
    assert.equal(w.spent(), 100_000_000n, "the charge is retained, not refunded on revocation");
  } finally { await w.close(); }
});

test("tenant: a pending approve vote still reconciles read-only after revocation, without a new approve or a refund", async () => {
  const w = await tenantSetup({ scenario: "valid" });
  try {
    const ours = signingRequest(w.wallet, w.vendor);
    w.turnkey.activities.set(ours.id, ours);
    w.turnkey.control.voteStatus = "ACTIVITY_STATUS_PENDING"; // Turnkey takes the vote but does not finish it
    await w.approver.poll();
    assert.equal(w.record(ours.id)!.state, "VOTE_PENDING");
    const voteId = w.record(ours.id)!.voteActivityId!;
    const requestsBefore = w.turnkey.votes.length;
    assert.equal(w.customers.revoke(w.acmeId), true);
    await w.approver.poll(); // reconciliation queries the pending vote by id; it is read-only, not a new submission
    assert.equal(w.turnkey.votes.length, requestsBefore, "no new vote submitted");
    w.turnkey.settleVote(voteId, "ACTIVITY_STATUS_COMPLETED"); // the earlier vote completes
    await w.approver.poll();
    assert.equal(w.record(ours.id)!.state, "SIGNING_COMPLETED", "an already-submitted vote is followed to its end");
    assert.equal(w.spent(), 100_000_000n, "charged once, never refunded");
  } finally { await w.close(); }
});

test("tenant: a customer revoked while its review is pending cannot have the human approval consumed into an approve vote", async () => {
  const w = await tenantSetup({ scenario: "valid" });
  try {
    const ours = signingRequest(w.wallet, Keypair.generate().publicKey); // not the vendor: goes to human review
    w.turnkey.activities.set(ours.id, ours);
    await w.approver.poll();
    const reviewId = String(w.events.find((e) => e.type === "turnkey_review_linked")!.data.reviewId);
    assert.equal(w.record(ours.id)!.state, "REVIEW_OPEN");
    assert.equal(w.customers.revoke(w.acmeId), true); // revoked while awaiting review
    openSqliteDatabase(w.path).prepare("UPDATE pending_reviews SET status = 'APPROVED', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), reviewId);
    await w.approver.poll();
    assert.equal(w.approveVotes(), 0, "a revoked customer's human approval cannot be consumed into an approve vote");
    assert.equal(w.record(ours.id)!.state, "REJECTED");
    assert.equal(w.spent(), 0n, "no charge was made, and none is refunded");
  } finally { await w.close(); }
});

/** A signing activity whose vendor destination lives only in an Address Lookup Table, so decoding awaits the resolver. */
function altSigningRequest(wallet: PublicKey, vendor: PublicKey): { activity: TurnkeyActivity; table: AddressLookupTableAccount } {
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: { deactivationSlot: 0xffffffffffffffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: wallet, addresses: [vendor] }
  });
  const message = new TransactionMessage({
    payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(),
    instructions: [SystemProgram.transfer({ fromPubkey: wallet, toPubkey: vendor, lamports: Number(LAMPORTS) })]
  }).compileToV0Message([table]);
  assert.equal(message.addressTableLookups.length, 1, "setup: the vendor must be resolved through the ALT");
  counter += 1;
  const unsignedTransaction = Buffer.from(new VersionedTransaction(message).serialize()).toString("hex");
  const activity = { id: `alt-${counter}`, organizationId: "org", status: "ACTIVITY_STATUS_CONSENSUS_NEEDED", type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", fingerprint: `fp-alt-${counter}`, intent: { signTransactionIntentV2: { signWith: wallet.toBase58(), unsignedTransaction, type: "TRANSACTION_TYPE_SOLANA" } } } as TurnkeyActivity;
  return { activity, table };
}

test("tenant: revoking the customer while evaluation is paused at an awaited lookup prevents any approve vote", async () => {
  let arrived!: () => void; const atBarrier = new Promise<void>((r) => { arrived = r; });
  let release!: () => void; const paused = new Promise<void>((r) => { release = r; });
  let table: AddressLookupTableAccount | undefined;
  const w = await tenantSetup({ scenario: "valid", resolveLookupTable: async (key) => { arrived(); await paused; return table && key.equals(table.key) ? table : null; } });
  try {
    const built = altSigningRequest(w.wallet, w.vendor);
    table = built.table;
    w.turnkey.activities.set(built.activity.id, built.activity);
    const polling = w.approver.poll();
    await atBarrier; // evaluation is paused at the ALT resolver, before any vote has been submitted
    assert.equal(w.customers.revoke(w.acmeId), true); // revoke the customer now
    release();
    await polling;
    assert.equal(w.approveVotes(), 0, "no APPROVE vote is sent after the customer was revoked mid-evaluation");
    assert.ok(w.turnkey.votes.some((v) => v.kind === "REJECT"), "the request is rejected instead");
    assert.equal(w.record(built.activity.id)!.state, "REJECTED");
    assert.equal(w.spent(), LAMPORTS, "the charge made during evaluation is retained, not refunded on revocation");
  } finally { await w.close(); }
});

test("tenant: recovering an already-consumed approval after revocation sends no new approve and retains accounting", async () => {
  // Crash right after the approval is consumed and charged, before VOTING is persisted: the approval is marked used
  // (consumed_by set) and the charge is held, exactly the state a crash would leave for recovery.
  const w = await tenantSetup({ scenario: "valid", lifecycle: (path) => new CrashingLifecycle(path, (u) => u.state === "VOTING") });
  try {
    const ours = signingRequest(w.wallet, Keypair.generate().publicKey); // not the vendor: a human review
    w.turnkey.activities.set(ours.id, ours);
    await w.approver.poll();
    const reviewId = String(w.events.find((e) => e.type === "turnkey_review_linked")!.data.reviewId);
    openSqliteDatabase(w.path).prepare("UPDATE pending_reviews SET status = 'APPROVED', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), reviewId);
    await w.approver.poll(); // consumes + charges, then the injected crash fires before VOTING is saved
    assert.equal(w.record(ours.id)!.state, "REVIEW_OPEN", "the consume charged but VOTING was never saved");
    assert.equal(w.spent(), LAMPORTS, "the approval's spend is held under the activity key");
    assert.equal(w.customers.revoke(w.acmeId), true); // the customer is revoked before recovery is attempted
    await w.approver.poll(); // recovery pass: the already-consumed approval must not become a new approve vote
    assert.equal(w.approveVotes(), 0, "recovery submits no new approve vote for a revoked customer");
    assert.ok(w.turnkey.votes.some((v) => v.kind === "REJECT"));
    assert.equal(w.record(ours.id)!.state, "REJECTED");
    assert.equal(w.spent(), LAMPORTS, "the already-consumed charge is retained, not refunded on revocation");
  } finally { await w.close(); }
});
