/**
 * The reviewer pages: the queue (/operator/reviews) and a review (/review/:id) are one static shell and one
 * same-origin script. The shell holds no review data and is the same bytes for every review id, real or not, so
 * a link alone reveals nothing. After sign-in the script reads /operator/api/reviews with the reviewer token in a
 * header and builds every element with textContent, so nothing from a review is ever parsed as HTML.
 *
 * The token lives in one variable: not in the URL, storage, a cookie, a form field or the page. Moving between
 * the queue and a review inside the page keeps it (history.pushState, no reload), so approve and deny reuse it.
 * A reload, a new tab or a Slack link asks for it again.
 */

export const APP_PAGE_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'";

export const APP_SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentGuard reviews</title>
<style>
  :root { color-scheme: light; --ink: #1c2024; --muted: #5f6670; --line: #e3e5e8; --bg: #f4f5f7; --accent: #4f46e5; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  header { background: #fff; border-bottom: 1px solid var(--line); }
  .bar { max-width: 1040px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 600; color: inherit; text-decoration: none; }
  .brand-mark { width: 22px; height: 22px; border-radius: 6px; background: linear-gradient(135deg, #5b5bf6, #8b5cf6); }
  .brand small { color: var(--muted); font-weight: 400; }
  .spacer { flex: 1; }
  main { max-width: 1040px; margin: 0 auto; padding: 20px; }
  .panel { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
  .login { max-width: 440px; margin: 40px auto; }
  .login h1 { font-size: 18px; margin: 0 0 6px; }
  .login p { color: var(--muted); margin: 0 0 14px; }
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  input, select { font: inherit; border: 1px solid #cfd3d8; border-radius: 6px; padding: 7px 9px; background: #fff; color: var(--ink); min-width: 0; }
  input:focus, select:focus, button:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .login input { width: 100%; margin-bottom: 12px; }
  button { font: inherit; font-weight: 600; border: 1px solid #cfd3d8; background: #fff; color: var(--ink); border-radius: 6px; padding: 7px 14px; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.approve { background: #16a34a; border-color: #16a34a; color: #fff; }
  button.deny { background: #dc2626; border-color: #dc2626; color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .filters { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 14px; }
  .filters > div { display: flex; flex-direction: column; }
  .filters .grow { flex: 1; min-width: 160px; }
  .meta-line { display: flex; gap: 10px; align-items: center; color: var(--muted); font-size: 12px; margin: 0 0 10px; flex-wrap: wrap; }
  .alert { border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; background: #fdecec; color: #8f1d1d; border: 1px solid #f5c2c2; }
  .notice { border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; background: #eef6ff; color: #1e3a8a; border: 1px solid #c7dbf7; }
  .warning { border-radius: 8px; padding: 10px 12px; margin: 0 0 12px; background: #fff8ed; color: #7a3d06; border: 1px solid #fcd9a8; font-size: 13px; }
  .empty, .loading { text-align: center; color: var(--muted); padding: 36px 12px; }
  ol.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .item { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; }
  .item:hover { border-color: #c9ccd2; }
  .row1 { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .agent { font-weight: 600; overflow-wrap: anywhere; }
  .summary { overflow-wrap: anywhere; }
  .reasons { margin: 0; padding-left: 18px; color: #3b4048; font-size: 13px; }
  .reasons li { overflow-wrap: anywhere; }
  .facts { color: var(--muted); font-size: 12px; display: flex; gap: 6px 14px; flex-wrap: wrap; }
  .facts span { overflow-wrap: anywhere; }
  .side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; text-align: right; font-size: 12px; color: var(--muted); }
  .open { display: inline-block; font-weight: 600; color: var(--accent); text-decoration: none; padding: 6px 0; font-size: 13px; }
  .open:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; }
  .s-PENDING, .t-wait { background: #fff4e5; color: #9a4a06; }
  .s-APPROVED, .t-good { background: #e6f6ea; color: #146c34; }
  .s-DENIED, .t-bad { background: #fdeaea; color: #a51c1c; }
  .s-EXPIRED, .t-neutral { background: #ececf0; color: #4b4b55; }
  .t-unknown { background: #fef9c3; color: #854d0e; }
  .tag { background: #eef0f3; color: #3b4048; font-weight: 500; }
  .tag.warn { background: #fff4e5; color: #9a4a06; }
  .tag.danger { background: #fdeaea; color: #a51c1c; }
  .soon { color: #9a4a06; font-weight: 600; }
  .pager { display: flex; gap: 8px; justify-content: space-between; align-items: center; margin-top: 14px; color: var(--muted); font-size: 12px; }
  .note { color: var(--muted); font-size: 12px; margin-top: 16px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 24px 28px; }
  .card h1 { font-size: 20px; margin: 0 0 10px; }
  .card h2 { font-size: 13px; margin: 24px 0 10px; color: #52525b; text-transform: uppercase; letter-spacing: 0.04em; }
  .headline { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .lead { font-size: 15px; margin: 0 0 6px; overflow-wrap: anywhere; }
  .grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 16px 0; font-size: 14px; }
  .grid dt { color: #52525b; }
  .grid dd { margin: 0; overflow-wrap: anywhere; }
  ol.steps { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 8px; }
  ol.steps > li { padding: 12px 14px; border-top: 1px solid var(--line); display: grid; grid-template-columns: 150px 1fr; gap: 4px 14px; }
  ol.steps > li:first-child { border-top: none; }
  .step-name { color: #52525b; font-weight: 500; }
  .step-body { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; overflow-wrap: anywhere; }
  ul.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  .instruction { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; background: #fafafa; }
  .instruction-head { margin-bottom: 6px; overflow-wrap: anywhere; }
  code { font-size: 12px; background: #ececf0; padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; font-size: 12px; color: #3f3f46; }
  .ai-note { border: 1px solid #c7d2fe; background: #eef2ff; border-radius: 8px; padding: 12px 14px; }
  .ai-note p { margin: 0 0 8px; }
  details { margin-top: 20px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; font-size: 13px; }
  summary { cursor: pointer; font-weight: 600; color: #52525b; }
  .actions { display: flex; gap: 10px; margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--line); flex-wrap: wrap; align-items: center; }
  .confirm { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; width: 100%; }
  .back { display: inline-block; margin-bottom: 12px; color: var(--accent); text-decoration: none; font-weight: 600; font-size: 13px; }
  [hidden] { display: none !important; }
  @media (max-width: 640px) {
    main { padding: 12px; }
    .item { grid-template-columns: 1fr; }
    .side { align-items: flex-start; text-align: left; flex-direction: row; flex-wrap: wrap; gap: 6px 12px; }
    .filters .grow { min-width: 100%; }
    .card { padding: 18px 16px; }
    .grid { grid-template-columns: 1fr; gap: 2px; }
    .grid dt { margin-top: 8px; }
    ol.steps > li { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<header><div class="bar">
  <a class="brand" href="/operator/reviews" id="home"><div class="brand-mark"></div>AgentGuard <small>Reviews</small></a>
  <div class="spacer"></div>
  <span id="who" class="meta-line" hidden></span>
  <button type="button" id="forget" hidden>Sign out</button>
</div></header>
<main>
  <noscript><div class="alert">Reviews need JavaScript: the page loads a review only after you sign in.</div></noscript>
  <form id="login" class="panel login" method="post" action="#" autocomplete="off" hidden>
    <h1 id="login-title">Sign in to review</h1>
    <p>Enter your reviewer token. It is kept only in this tab and is forgotten when you close or reload it.</p>
    <label for="token">Reviewer token</label>
    <input id="token" type="password" autocomplete="off" spellcheck="false" required>
    <button type="submit" class="primary">Sign in</button>
    <div id="login-error" class="alert" role="alert" hidden></div>
  </form>
  <section id="queue" hidden>
    <form id="filters" class="filters" method="post" action="#">
      <div><label for="status">Status</label>
        <select id="status"><option value="PENDING">Waiting for review</option><option value="APPROVED">Approved</option><option value="DENIED">Denied</option><option value="EXPIRED">Expired</option><option value="ALL">All</option></select></div>
      <div><label for="chain">Chain</label>
        <select id="chain"><option value="">Any</option><option value="solana">Solana</option><option value="evm">EVM</option><option value="unknown">Not recorded</option></select></div>
      <div class="grow"><label for="agent">Agent</label><input id="agent" maxlength="200" placeholder="Exact agent ID"></div>
      <div><button type="submit">Apply</button></div>
      <div><button type="button" id="refresh">Refresh</button></div>
    </form>
    <div class="meta-line">
      <span id="updated">Not loaded yet</span>
      <label style="margin:0;display:flex;gap:6px;align-items:center"><input type="checkbox" id="auto"> Refresh every 30 seconds</label>
    </div>
    <div id="error" class="alert" role="alert" hidden></div>
    <div id="loading" class="loading" hidden>Loading reviews</div>
    <div id="empty" class="empty" hidden></div>
    <ol id="list" class="list" aria-live="polite"></ol>
    <div class="pager"><button type="button" id="newer">Newer</button><span id="page">Page 1</span><button type="button" id="older">Older</button></div>
    <p class="note">Amounts are in base units (lamports, wei or token units). An approval marked as used was spent on a signing request or Turnkey vote; open the review to see what happened afterwards.</p>
  </section>
  <section id="detail" hidden aria-live="polite"></section>
</main>
<script src="/operator/app.js"></script>
</body>
</html>`;

export const APP_SCRIPT = `"use strict";
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var STATUSES = ["PENDING", "APPROVED", "DENIED", "EXPIRED", "ALL"];
  var REFRESH_MS = 30000, MAX_REFRESHES = 60;
  var token = "";
  var cursors = [null], page = 0, nextCursor = null, inFlight = false, refreshes = 0, timer = null;
  var queueSearch = "", detailBusy = false;
  // Every UI-loading operation (queue load, detail load, decide) takes the next generation and remembers the token
  // it ran under. A response may touch the interface only while its generation is still the latest and the token is
  // unchanged, so a response that arrives after navigation, sign-out, a credential change or a newer request in the
  // same lane is dropped instead of overwriting the current view. Cancellation is a bonus, not the guarantee.
  var generation = 0;
  function begin() { generation += 1; return { g: generation, session: token }; }
  function current(req) { return req.g === generation && token !== "" && token === req.session; }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function show(id, on) { $(id).hidden = !on; }
  function ago(iso) {
    var s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return "at an unknown time";
    var future = s < 0; s = Math.abs(s);
    var text = s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + " min" : s < 86400 ? Math.round(s / 3600) + " h" : Math.round(s / 86400) + " d";
    return future ? "in " + text : text + " ago";
  }
  function api(path, init) {
    init = init || {};
    return fetch(path, { method: init.method || "GET", redirect: init.redirect || "follow", headers: { "x-reviewer-token": token, accept: "application/json" }, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  }
  function readJson(response) {
    return response.json().catch(function () { return {}; }).then(function (body) { return { status: response.status, body: body }; });
  }

  // Routing: /review/<id> is one review, anything else the queue. Moving between them keeps the token.
  function route() {
    var m = location.pathname.match(/^\\/review\\/([^\\/]+)$/);
    if (!m) return { view: "queue" };
    var id = "";
    try { id = decodeURIComponent(m[1]); } catch (e) { id = ""; }
    return { view: "detail", id: /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null };
  }
  function go(path) { history.pushState(null, "", path); render(); }
  function render() {
    var r = route();
    if (!token) {
      show("queue", false); show("detail", false); show("login", true);
      $("login-title").textContent = r.view === "detail" ? "Sign in to see this review" : "Sign in to the review queue";
      $("token").focus();
      return;
    }
    show("login", false); show("forget", true);
    if (r.view === "detail") { show("queue", false); show("detail", true); loadDetail(r.id); }
    else { show("detail", false); show("queue", true); readFilters(); restart(); }
  }
  function signOut(message) {
    generation += 1; // invalidate every outstanding request: none may render into the signed-out interface
    token = ""; cursors = [null]; page = 0; detailBusy = false;
    $("list").replaceChildren(); $("detail").replaceChildren();
    $("auto").checked = false; stopAuto();
    show("forget", false); show("who", false);
    $("login-error").textContent = message || ""; show("login-error", Boolean(message));
    render();
  }
  /** Answers that mean the credential or the server's review setup, the same on every call. */
  function credentialProblem(r) {
    if (r.status === 401) { signOut("That token was not accepted. Check it, or ask an administrator for a new one."); return true; }
    if (r.status === 503) { signOut(r.body.message || "Reviews are switched off on this server."); return true; }
    return false;
  }

  // ---- Queue ----
  function readFilters() {
    var query = new URLSearchParams(location.search);
    $("status").value = STATUSES.indexOf(query.get("status")) >= 0 ? query.get("status") : "PENDING";
    $("chain").value = ["solana", "evm", "unknown"].indexOf(query.get("chain")) >= 0 ? query.get("chain") : "";
    $("agent").value = (query.get("agent") || "").slice(0, 200);
  }
  function filters() { return { status: $("status").value, chain: $("chain").value, agent: $("agent").value.trim() }; }
  function syncUrl() {
    var f = filters(), q = new URLSearchParams();
    if (f.status !== "PENDING") q.set("status", f.status);
    if (f.chain) q.set("chain", f.chain);
    if (f.agent) q.set("agent", f.agent);
    queueSearch = q.toString() ? "?" + q.toString() : "";
    history.replaceState(null, "", "/operator/reviews" + queueSearch);
  }
  function setError(message) { $("error").textContent = message || ""; show("error", Boolean(message)); }

  function row(item) {
    var li = el("li", "item");
    var main = el("div");
    var head = el("div", "row1");
    head.appendChild(el("span", "badge s-" + item.status, item.status === "PENDING" ? "Waiting" : item.status.charAt(0) + item.status.slice(1).toLowerCase()));
    head.appendChild(el("span", "agent", item.agentId));
    if (item.summary.unlimitedApproval) head.appendChild(el("span", "badge tag danger", "Unlimited approval"));
    if (item.turnkey) head.appendChild(el("span", "badge tag" + (item.turnkey.state === "VOTE_UNKNOWN" ? " warn" : ""), "Turnkey: " + item.turnkey.label));
    if (item.approvalUsed) {
      var used = el("span", "badge tag", "Approval used");
      used.title = "Spent on a signing request or vote. Not proof that anything was signed.";
      head.appendChild(used);
    }
    main.appendChild(head);
    main.appendChild(el("div", "summary", item.summary.text));
    if (item.reasons.length) {
      var reasons = el("ul", "reasons");
      item.reasons.slice(0, 3).forEach(function (r) { reasons.appendChild(el("li", null, r)); });
      if (item.reasons.length > 3) reasons.appendChild(el("li", null, "and " + (item.reasons.length - 3) + " more"));
      main.appendChild(reasons);
    } else main.appendChild(el("div", "facts", "No reason recorded"));
    var facts = el("div", "facts");
    facts.appendChild(el("span", null, "Chain: " + item.chainLabel));
    facts.appendChild(el("span", null, "Policy: " + (item.policyId || "not recorded") + (item.policyFingerprint ? " (rev " + item.policyFingerprint.slice(0, 8) + ")" : "")));
    if ("customerId" in item) facts.appendChild(el("span", null, "Customer: " + (item.customerId || "none (open mode)")));
    if (item.resolvedBy) facts.appendChild(el("span", null, (item.status === "APPROVED" ? "Approved" : "Denied") + " by " + (item.resolvedBy.kind === "reviewer" ? item.resolvedBy.name : "the shared secret") + " " + ago(item.resolvedAt)));
    main.appendChild(facts);
    li.appendChild(main);
    var side = el("div", "side");
    side.appendChild(el("span", null, "Opened " + ago(item.createdAt)));
    if (item.status === "PENDING") side.appendChild(el("span", Date.parse(item.expiresAt) - Date.now() < 5 * 60000 ? "soon" : null, "Expires " + ago(item.expiresAt)));
    else if (item.status === "EXPIRED") side.appendChild(el("span", null, "Expired " + ago(item.expiresAt)));
    var link = el("a", "open", item.status === "PENDING" ? "Review" : "View details");
    link.href = "/review/" + encodeURIComponent(item.id);
    link.setAttribute("aria-label", (item.status === "PENDING" ? "Review " : "View ") + item.agentId + " request");
    link.addEventListener("click", function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return; // a new tab signs in again
      event.preventDefault(); go(link.getAttribute("href"));
    });
    side.appendChild(link);
    li.appendChild(side);
    return li;
  }
  function renderQueue(body) {
    var list = $("list");
    list.replaceChildren();
    body.items.forEach(function (item) { list.appendChild(row(item)); });
    nextCursor = body.nextCursor;
    var f = filters();
    $("empty").textContent = f.status === "PENDING" && !f.agent && !f.chain ? "Nothing is waiting for review." : "No reviews match these filters.";
    show("empty", body.items.length === 0);
    $("older").disabled = !nextCursor;
    $("newer").disabled = page === 0;
    $("page").textContent = "Page " + (page + 1);
    $("updated").textContent = "Updated " + new Date().toLocaleTimeString();
    $("who").textContent = body.scope === "all" ? "All customers" : "Your customer's reviews";
    show("who", true);
  }
  function loadQueue() {
    if (inFlight || !token || route().view !== "queue") return;
    inFlight = true;
    var req = begin();
    setError("");
    show("loading", $("list").children.length === 0);
    var f = filters(), q = new URLSearchParams();
    q.set("status", f.status);
    if (f.chain) q.set("chain", f.chain);
    if (f.agent) q.set("agent", f.agent);
    if (cursors[page]) q.set("cursor", cursors[page]);
    api("/operator/api/reviews?" + q.toString()).then(readJson)
      .then(function (r) {
        if (!current(req) || route().view !== "queue") return; // navigated, signed out or superseded: drop this result
        if (credentialProblem(r)) return;
        if (r.status === 200) return renderQueue(r.body);
        if (r.status === 429) return setError("Too many requests from this address. Wait a minute, then refresh.");
        setError(r.body.message || "The server could not list reviews (status " + r.status + ").");
      })
      .catch(function () { if (current(req) && route().view === "queue") setError("Could not reach the server. Check your connection, then refresh."); })
      .then(function () { if (current(req)) { inFlight = false; if (route().view === "queue") show("loading", false); } });
  }
  function restart() {
    // A filter or navigation change: invalidate any in-flight queue request (its late response must not render the
    // old filter's results) and let a fresh request start at once.
    generation += 1; inFlight = false;
    cursors = [null]; page = 0; syncUrl(); $("list").replaceChildren(); loadQueue();
  }
  function stopAuto() { if (timer) clearInterval(timer); timer = null; }

  // ---- One review ----
  function field(dl, name, value) { dl.appendChild(el("dt", null, name)); var dd = el("dd"); if (typeof value === "string") dd.textContent = value; else dd.appendChild(value); dl.appendChild(dd); }
  function codeText(text) { return el("code", null, text); }
  function badge(text, cls) { return el("span", "badge " + cls, text); }

  function renderDetail(d, notice) {
    var box = $("detail");
    var back = el("a", "back", "Back to the queue");
    back.href = "/operator/reviews" + queueSearch;
    back.addEventListener("click", function (event) { event.preventDefault(); go(back.getAttribute("href")); });
    var card = el("article", "card");
    if (notice) card.appendChild(el("div", "notice", notice));
    card.appendChild(el("h1", null, "Transaction review"));
    var headline = el("div", "headline");
    headline.appendChild(badge(d.status, "s-" + d.status));
    if (d.summary.unlimitedApproval) headline.appendChild(badge("Unlimited approval", "tag danger"));
    headline.appendChild(el("span", "agent", d.agentId));
    card.appendChild(headline);
    d.warnings.forEach(function (w) { card.appendChild(el("p", "warning", w)); });
    card.appendChild(el("p", "lead", d.summary.text));

    var dl = el("dl", "grid");
    field(dl, "Created", d.createdAt);
    field(dl, "Expires", d.expiresAt);
    field(dl, "Agent", d.agentId);
    field(dl, "Chain", d.chainLabel);
    if ("customerId" in d) field(dl, "Customer", d.customerId || "none (open mode)");
    field(dl, "Policy", (d.policyId || "not recorded") + (d.policyFingerprint ? " (revision " + d.policyFingerprint.slice(0, 12) + "). " : ". ") + d.currentPolicyText);
    field(dl, "Fee payer", d.feePayer);
    if (d.lastRefusal) {
      var refusal = el("span");
      refusal.appendChild(codeText(d.lastRefusal.code));
      refusal.appendChild(document.createTextNode(" " + d.lastRefusal.meaning + " (" + d.lastRefusal.at + ")"));
      field(dl, "Last refused use", refusal);
    }
    card.appendChild(dl);

    card.appendChild(el("h2", null, "What happened"));
    var steps = el("ol", "steps");
    d.steps.forEach(function (step) {
      var li = el("li");
      li.appendChild(el("span", "step-name", step.label));
      var body = el("div", "step-body");
      if (step.badge) body.appendChild(badge(step.badge, "t-" + (step.tone || "neutral")));
      body.appendChild(el("span", null, step.text));
      if (step.items && step.items.length) { var ul = el("ul", "reasons"); step.items.forEach(function (i) { ul.appendChild(el("li", null, i)); }); body.appendChild(ul); }
      if (step.code) { var c = el("span"); c.appendChild(codeText(step.code)); c.appendChild(document.createTextNode(" " + (step.codeMeaning || ""))); body.appendChild(c); }
      li.appendChild(body);
      steps.appendChild(li);
    });
    card.appendChild(steps);

    if (d.advisoryExplanation) {
      var x = d.advisoryExplanation;
      card.appendChild(el("h2", null, "AI-generated note (advisory only, model: " + x.model + ")"));
      var note = el("div", "ai-note");
      note.appendChild(el("p", null, x.summary));
      if (x.risks && x.risks.length) { var risks = el("ul", "reasons"); x.risks.forEach(function (r) { risks.appendChild(el("li", null, r)); }); note.appendChild(risks); }
      if (x.truncated) note.appendChild(el("p", null, "The transaction was too long for the model to see all of it."));
      note.appendChild(el("p", "note", "Written by a language model from untrusted transaction data. It did not influence the policy decision. Check it against the decoded instructions below."));
      card.appendChild(note);
    }

    card.appendChild(el("h2", null, "Decoded instructions"));
    var list = el("ul", "plain");
    d.instructions.forEach(function (i) {
      var li = el("li", "instruction");
      var head = el("div", "instruction-head");
      head.appendChild(codeText(i.programId));
      head.appendChild(document.createTextNode(" "));
      head.appendChild(el("strong", null, i.instructionName));
      head.appendChild(el("span", "note", " (" + i.mode + ")"));
      li.appendChild(head);
      li.appendChild(el("pre", null, JSON.stringify(i.fields)));
      list.appendChild(li);
    });
    card.appendChild(list);

    var tech = el("details");
    tech.appendChild(el("summary", null, "Technical details"));
    var t = el("dl", "grid");
    field(t, "Review ID", codeText(d.id));
    field(t, "Transaction hash", codeText(d.transactionHash || "not recorded"));
    field(t, "Policy revision", codeText(d.policyFingerprint || "not recorded"));
    field(t, "Approval used at", d.approvalUsedAt || "not used");
    if (d.turnkeyActivity) {
      var a = d.turnkeyActivity;
      field(t, "Turnkey signing request", a.activityId + " in organization " + a.organizationId + ", AgentGuard state " + a.state + ", recorded " + a.createdAt + ", last changed " + a.updatedAt);
      if (a.vote) field(t, "AgentGuard's " + a.vote.kind.toLowerCase() + " vote", (a.vote.activityId ? "vote activity " + a.vote.activityId : "no vote activity id received") + ", status " + (a.vote.status || "not reported") + ", " + a.vote.requests + " request(s) sent");
      if (a.accountingRetained) field(t, "Budget", "Charge kept until its outcome is known (may overcount the day's spending)");
      if (a.nextCheckAt) field(t, "Next check", a.nextCheckAt);
      if (a.detail) field(t, "Turnkey detail", a.detail);
    }
    if (d.outcome && d.outcome.reference) field(t, "Signature or transaction", codeText(d.outcome.reference));
    field(t, "Transaction bytes", "Not stored. The approval is bound to the transaction hash above.");
    tech.appendChild(t);
    card.appendChild(tech);

    if (d.actionable) card.appendChild(actions(d));
    box.replaceChildren(back, card);
  }

  function actions(d) {
    var bar = el("div", "actions");
    var approve = el("button", "approve", "Approve"); approve.type = "button";
    var deny = el("button", "deny", "Deny"); deny.type = "button";
    var message = el("div", "alert"); message.hidden = true; message.setAttribute("role", "alert");
    var ask = function (action) {
      var confirm = el("div", "confirm");
      confirm.appendChild(el("span", null, action === "approve" ? "Approve this exact transaction? The agent can then use the approval once." : "Deny this transaction?"));
      var yes = el("button", action === "approve" ? "approve" : "deny", action === "approve" ? "Confirm approval" : "Confirm denial"); yes.type = "button";
      var no = el("button", null, "Cancel"); no.type = "button";
      yes.addEventListener("click", function () { decide(d.id, action, message, [yes, no]); });
      no.addEventListener("click", function () { bar.replaceChildren(approve, deny, message); });
      confirm.appendChild(yes); confirm.appendChild(no);
      bar.replaceChildren(confirm, message);
      yes.focus();
    };
    approve.addEventListener("click", function () { ask("approve"); });
    deny.addEventListener("click", function () { ask("deny"); });
    bar.replaceChildren(approve, deny, message);
    return bar;
  }

  /**
   * Approve or deny through the existing POST action, with the token in a header. The server answers what this
   * request did ("applied", "already_decided", "expired"); that answer, not the review's final status, decides
   * the confirmation, because someone else may have made the same decision first.
   */
  function decide(id, action, message, buttons) {
    if (detailBusy) return;
    detailBusy = true;
    var req = begin();
    // This decision belongs to the review on screen now. If the operator navigates away (or signs out) before the
    // response arrives, the result must not reopen this review or alter the new view; the decision still stands
    // server-side, we simply do not touch the interface.
    function mine() { var r = route(); return current(req) && r.view === "detail" && r.id === id; }
    buttons.forEach(function (b) { b.disabled = true; });
    api("/review/" + encodeURIComponent(id) + "/" + action, { method: "POST" }).then(readJson)
      .then(function (r) {
        if (!mine()) return;
        var outcome = r.body && r.body.outcome;
        if (outcome === "applied") return loadDetail(id, action === "approve" ? "You approved this review." : "You denied this review.");
        if (outcome === "already_decided") {
          return loadDetail(id, "Your " + (action === "approve" ? "approval" : "denial") + " was not recorded: this review had already been " + String(r.body.status).toLowerCase() + ". The decision below stands.");
        }
        if (outcome === "expired") return loadDetail(id, "This review expired before your decision was recorded. Nothing was approved or denied.");
        if (r.status === 401) return signOut("That token is no longer accepted. Sign in again.");
        var text = r.status === 404 ? "This review is not visible to you, so nothing was changed."
          : r.status === 429 ? "Too many attempts from this address. Wait a minute, then try again."
            : r.status === 503 ? "Review actions are switched off on this server."
              : "The decision was not recorded (status " + r.status + "). Reload the review before trying again.";
        message.textContent = text; message.hidden = false;
        buttons.forEach(function (b) { b.disabled = false; });
      })
      .catch(function () {
        if (!mine()) return;
        message.textContent = "Could not reach the server. Reload the review to see whether your decision was recorded.";
        message.hidden = false;
        buttons.forEach(function (b) { b.disabled = false; });
      })
      .then(function () { if (mine()) detailBusy = false; });
  }

  /** Loads and shows a review. "notice", when given, is the result of this tab's own approve or deny request. */
  function loadDetail(id, notice) {
    detailBusy = false;
    var box = $("detail");
    var back = el("a", "back", "Back to the queue");
    back.href = "/operator/reviews" + queueSearch;
    back.addEventListener("click", function (event) { event.preventDefault(); go(back.getAttribute("href")); });
    if (!id) { box.replaceChildren(back, el("div", "alert", "This link does not name a review.")); return; }
    var req = begin();
    // A result renders only while this is still the current detail request for this id and session. A response for a
    // review the operator has navigated away from can never overwrite the one now on screen.
    function mine() { var r = route(); return current(req) && r.view === "detail" && r.id === id; }
    if (!notice) box.replaceChildren(el("div", "loading", "Loading the review"));
    return api("/operator/api/reviews/" + encodeURIComponent(id)).then(readJson)
      .then(function (r) {
        if (!mine()) return;
        if (credentialProblem(r)) return;
        if (r.status === 404) return box.replaceChildren(back, el("div", "alert", "No review with this id is visible to you. It may not exist, may belong to another customer, or may have been removed after the retention period."));
        if (r.status === 429) return box.replaceChildren(back, el("div", "alert", "Too many requests from this address. Wait a minute, then reload."));
        if (r.status !== 200) return box.replaceChildren(back, el("div", "alert", r.body.message || "The review could not be loaded (status " + r.status + ")."));
        $("who").textContent = "customerId" in r.body ? "All customers" : "Your customer's reviews";
        show("who", true);
        renderDetail(r.body, notice || "");
      })
      .catch(function () { if (mine()) box.replaceChildren(back, el("div", "alert", "Could not reach the server. Check your connection, then reload.")); });
  }

  // ---- Wiring ----
  $("login").addEventListener("submit", function (event) {
    event.preventDefault();
    token = $("token").value;
    $("token").value = "";
    if (!token) return;
    show("login-error", false);
    render();
  });
  $("forget").addEventListener("click", function () { signOut(""); });
  $("home").addEventListener("click", function (event) { event.preventDefault(); go("/operator/reviews" + queueSearch); });
  $("filters").addEventListener("submit", function (event) { event.preventDefault(); restart(); });
  $("status").addEventListener("change", restart);
  $("chain").addEventListener("change", restart);
  $("refresh").addEventListener("click", loadQueue);
  $("older").addEventListener("click", function () { if (!nextCursor || inFlight) return; cursors[page + 1] = nextCursor; page += 1; $("list").replaceChildren(); loadQueue(); });
  $("newer").addEventListener("click", function () { if (page === 0 || inFlight) return; page -= 1; $("list").replaceChildren(); loadQueue(); });
  $("auto").addEventListener("change", function () {
    stopAuto();
    if (!$("auto").checked) return;
    refreshes = 0;
    timer = setInterval(function () {
      if (document.hidden || inFlight || !token || route().view !== "queue") return;
      refreshes += 1;
      if (refreshes > MAX_REFRESHES) { $("auto").checked = false; stopAuto(); $("updated").textContent += " (automatic refresh stopped after 30 minutes)"; return; }
      loadQueue();
    }, REFRESH_MS);
  });
  document.addEventListener("visibilitychange", function () { if (!document.hidden && timer && route().view === "queue") loadQueue(); });
  window.addEventListener("popstate", render);
  render();
})();
`;
