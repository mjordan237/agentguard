import test from "node:test";
import assert from "node:assert/strict";
import { APP_SCRIPT } from "../src/escalation/operator-queue-page.js";

/**
 * Executes the shipped operator page script against a minimal DOM with a controllable fetch, so the real
 * request-handling code runs. Asserts that a response only updates the interface when it still belongs to the
 * current route, request generation and session; a response arriving after navigation, sign-out or a credential
 * change must not overwrite the current view.
 */

class El {
  tagName: string;
  className = "";
  private text = "";
  children: El[] = [];
  attrs: Record<string, string> = {};
  handlers: Record<string, Array<(e: unknown) => void>> = {};
  hidden = false;
  value = "";
  title = "";
  href = "";
  disabled = false;
  checked = false;
  style: Record<string, string> = {};
  constructor(tagName: string) { this.tagName = tagName; }
  set textContent(v: unknown) { this.text = v == null ? "" : String(v); this.children = []; }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(""); }
  appendChild(node: El) { this.children.push(node); return node; }
  replaceChildren(...nodes: El[]) { this.text = ""; this.children = nodes; }
  addEventListener(type: string, fn: (e: unknown) => void) { (this.handlers[type] ||= []).push(fn); }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  focus() { /* no-op */ }
  fire(type: string, event: unknown = { preventDefault() {}, metaKey: false, ctrlKey: false, shiftKey: false, button: 0 }) {
    for (const fn of this.handlers[type] ?? []) fn(event);
  }
}

interface Deferred { url: string; method: string; settle: (status: number, body: unknown) => void }

function harness(startPath: string) {
  const byId = new Map<string, El>();
  const document = {
    hidden: false,
    getElementById(id: string) { let el = byId.get(id); if (!el) { el = new El("div"); byId.set(id, el); } return el; },
    createElement(tag: string) { return new El(tag); },
    createTextNode(text: string) { const n = new El("#text"); n.textContent = text; return n; },
    handlers: {} as Record<string, Array<(e: unknown) => void>>,
    addEventListener(type: string, fn: (e: unknown) => void) { (this.handlers[type] ||= []).push(fn); }
  };
  const windowObj = {
    handlers: {} as Record<string, Array<(e: unknown) => void>>,
    addEventListener(type: string, fn: (e: unknown) => void) { (this.handlers[type] ||= []).push(fn); }
  };
  const location = { pathname: startPath.split("?")[0]!, search: startPath.includes("?") ? "?" + startPath.split("?")[1] : "" };
  const setLoc = (url: string) => { const [p, q] = url.split("?"); location.pathname = p!; location.search = q ? "?" + q : ""; };
  const history = { pushState: (_s: unknown, _t: unknown, url: string) => setLoc(url), replaceState: (_s: unknown, _t: unknown, url: string) => setLoc(url) };
  const pending: Deferred[] = [];
  const fetchImpl = (url: string, init?: { method?: string }) => new Promise((resolve) => {
    pending.push({ url, method: init?.method ?? "GET", settle: (status, body) => resolve({ status, json: () => Promise.resolve(body) }) });
  });
  const run = new Function("document", "window", "history", "location", "fetch", "setInterval", "clearInterval", APP_SCRIPT);
  run(document, windowObj, history, location, fetchImpl, () => 0, () => {});
  const $ = (id: string) => document.getElementById(id);
  return {
    $, location, pending,
    signIn(tokenValue: string) { $("token").value = tokenValue; $("login").fire("submit"); },
    navigate(path: string) { setLoc(path); for (const fn of windowObj.handlers["popstate"] ?? []) fn({}); },
    settle(index: number, status: number, body: unknown) { pending[index]!.settle(status, body); },
    detailText() { return $("detail").textContent; }
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A detail payload renderDetail accepts; `tag` appears in the rendered output (agent id and review id). */
function detailBody(tag: string, over: Record<string, unknown> = {}) {
  return {
    id: tag, status: "PENDING", actionable: true, agentId: "agent-" + tag, chain: "solana", chainLabel: "Solana",
    policyId: "p", policyFingerprint: "fp", createdAt: "2026-11-10T00:00:00.000Z", expiresAt: "2026-11-10T00:15:00.000Z",
    resolvedAt: null, resolvedBy: null, approvalUsed: false, approvalUsedAt: null, feePayer: "payer",
    currentPolicy: "matches", currentPolicyText: "The policy's current rules match the reviewed revision.",
    summary: { text: "Transfer of 1 native to X", unlimitedApproval: false }, reasons: [], warnings: [],
    steps: [{ step: "outcome", label: "Outcome", text: "No recorded signing outcome", badge: "No recorded signing outcome", tone: "neutral" }],
    lastRefusal: null, outcome: { kind: "none" }, turnkeyActivity: null, transactionHash: "h", advisoryExplanation: null,
    instructions: [{ programId: "11111111111111111111111111111111", instructionName: "transfer", mode: "interpolated", fields: {} }],
    ...over
  };
}

test("operator: request A then B, responses arriving B then A, leaves B on screen", async () => {
  const h = harness("/review/A");
  h.signIn("agr_token");
  await tick();
  assert.equal(h.pending[0]!.url, "/operator/api/reviews/A");
  h.navigate("/review/B");
  await tick();
  assert.equal(h.pending[1]!.url, "/operator/api/reviews/B");
  h.settle(1, 200, detailBody("B"));
  await tick();
  h.settle(0, 200, detailBody("A")); // the stale A response arrives last
  await tick();
  assert.match(h.detailText(), /agent-B/, "B is shown");
  assert.doesNotMatch(h.detailText(), /agent-A/, "the stale A response did not overwrite B");
  assert.equal(h.location.pathname, "/review/B");
});

test("operator: a detail response delivered after sign-out does not render into the signed-out page", async () => {
  const h = harness("/review/A");
  h.signIn("agr_token");
  await tick();
  h.$("forget").fire("click"); // sign out while A is in flight
  await tick();
  h.settle(0, 200, detailBody("A"));
  await tick();
  assert.doesNotMatch(h.detailText(), /agent-A/, "nothing from the old session rendered");
  assert.equal(h.$("login").hidden, false, "the sign-in page is shown");
});

test("operator: a response from a previous credential never appears after re-authentication", async () => {
  const h = harness("/review/A");
  h.signIn("agr_first");
  await tick();
  h.$("forget").fire("click");
  h.signIn("agr_second"); // new session, new request for A
  await tick();
  const first = h.pending.findIndex((p) => p.url === "/operator/api/reviews/A");
  const second = h.pending.length - 1;
  h.settle(second, 200, detailBody("A", { agentId: "agent-second" }));
  await tick();
  h.settle(first, 200, detailBody("A", { agentId: "agent-first" })); // the first session's response, delivered late
  await tick();
  assert.match(h.detailText(), /agent-second/);
  assert.doesNotMatch(h.detailText(), /agent-first/, "the previous credential's response was dropped");
});

test("operator: a stale 401 arriving after a newer successful detail load does not sign the operator out", async () => {
  const h = harness("/review/A");
  h.signIn("agr_token");
  await tick();
  h.navigate("/review/B");
  await tick();
  h.settle(1, 200, detailBody("B"));
  await tick();
  h.settle(0, 401, { error: "INVALID_REVIEWER_TOKEN" }); // stale A error after B rendered
  await tick();
  assert.match(h.detailText(), /agent-B/, "B is still shown");
  assert.equal(h.$("login").hidden, true, "a stale 401 did not force a sign-out");
});

test("operator: a decision completing after the operator navigated away does not reopen the earlier review", async () => {
  const h = harness("/review/A");
  h.signIn("agr_token");
  await tick();
  h.settle(0, 200, detailBody("A")); // A loaded with action buttons
  await tick();
  assert.match(h.detailText(), /agent-A/);
  // Approve A: find and click the approve button in the rendered detail, then navigate away before it resolves.
  const approve = findButton(h.$("detail"), "Approve");
  assert.ok(approve, "an approve button is rendered");
  approve!.fire("click");
  const confirm = findButton(h.$("detail"), "Confirm approval");
  assert.ok(confirm, "a confirmation button is rendered");
  confirm!.fire("click");
  const postIndex = h.pending.findIndex((p) => p.method === "POST");
  assert.ok(postIndex >= 0, "a decision POST was sent");
  h.navigate("/review/B"); // navigate away before the decision responds
  await tick();
  const bIndex = h.pending.findIndex((p) => p.url === "/operator/api/reviews/B");
  h.settle(bIndex, 200, detailBody("B"));
  await tick();
  h.settle(postIndex, 200, { id: "A", outcome: "applied", status: "APPROVED" }); // decision result arrives after navigation
  await tick();
  assert.match(h.detailText(), /agent-B/, "the current review B is shown");
  assert.doesNotMatch(h.detailText(), /agent-A/, "the stale decision did not reopen review A");
  assert.equal(h.location.pathname, "/review/B");
});

function findButton(root: El, label: string): El | undefined {
  if (root.tagName === "button" && root.textContent === label) return root;
  for (const c of root.children) { const found = findButton(c, label); if (found) return found; }
  return undefined;
}

/** A queue item renderQueue/row accept; `tag` appears in the rendered output via the agent id. */
function queueItem(tag: string) {
  return {
    id: tag, status: "PENDING", agentId: "agent-" + tag, chain: "solana", chainLabel: "Solana", policyId: "p", policyFingerprint: "fp",
    createdAt: "2026-11-10T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", resolvedAt: null, resolvedBy: null,
    approvalUsed: false, summary: { text: "Transfer of 1 native to X", unlimitedApproval: false }, reasons: [], turnkey: null
  };
}
const queueBody = (tag: string) => ({ scope: "customer", limit: 25, items: [queueItem(tag)], nextCursor: null });

test("operator: a queue filter change mid-request drops the old filter's late response and shows the new results", async () => {
  const h = harness("/operator/reviews");
  h.signIn("agr_token");
  await tick();
  const firstLoad = h.pending.length - 1;
  assert.match(h.pending[firstLoad]!.url, /\/operator\/api\/reviews\?/);
  h.$("status").value = "ALL";
  h.$("status").fire("change"); // restart() invalidates the in-flight request and starts a fresh one
  await tick();
  const secondLoad = h.pending.length - 1;
  assert.notEqual(secondLoad, firstLoad);
  h.settle(secondLoad, 200, queueBody("fresh"));
  await tick();
  h.settle(firstLoad, 200, queueBody("stale")); // the pre-change response arrives late
  await tick();
  assert.match(h.$("list").textContent, /agent-fresh/, "the new filter's results are shown");
  assert.doesNotMatch(h.$("list").textContent, /agent-stale/, "the pre-change response was dropped");
});
