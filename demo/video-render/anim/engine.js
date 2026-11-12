// Pure function of time: window.render(t) draws the frame at t seconds. window.DATA is injected by the
// renderer from the captured real run (see ../capture.mjs and ../render-anim.mjs).
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TOTAL = 110;

const CAPTIONS = [
  [0.4, 5.6, "AgentGuard checks what an AI agent is about to sign, before it signs."],
  [6.3, 10.6, "An agent's transaction can carry more than the payment you can see."],
  [10.8, 15.2, "A hidden instruction moves no money, so a spending limit never notices it."],
  [15.4, 18.8, "Researchers found every one of 15 major x402 facilitators broke a security rule."],
  [19.6, 24, "AgentGuard reads every instruction and applies the customer's own rules."],
  [24.2, 28.8, "Allowed payments are signed. Everything else is held for a person."],
  [29.6, 33.6, "A normal payment: approved vendor, under the limit, plain transfer."],
  [34, 38.6, "It is allowed, and signed by the relayer."],
  [39.6, 43, "Now the same payment with one extra instruction added."],
  [43.2, 46.8, "AgentGuard cannot read it, so it does not guess."],
  [47, 52.6, "The whole transaction is held for a person."],
  [53.6, 58.6, "A payment to an address nobody approved is held too."],
  [59.2, 64.6, "So is an approved vendor with an amount over the limit."],
  [65.4, 70.5, "Here is the held payment, as the reviewer sees it."],
  [70.6, 76.5, "They check the decoded instructions, enter their own token and approve."],
  [76.6, 83.6, "The agent retries and is signed once. The same approval cannot be used again."],
  [84.6, 90, "The same checks on Ethereum, an early preview."],
  [90.4, 99.5, "An unlimited approval to a spender nobody listed is held."],
  [100.5, 105.5, "Working open-source core, tested, and no customers yet."],
  [105.6, 109.6, "We are looking for five design partners."]
];

const scenes = [...document.querySelectorAll(".scene")];
const timed = [...document.querySelectorAll("[data-t]")];
const caption = document.getElementById("caption");
const bar = document.getElementById("bar");
const D = window.DATA;

// ---- fill real data -------------------------------------------------------------------------------
function jsonPanel(result, extraKeys) {
  const b = result.body ?? {};
  const lines = [`<span class="k">HTTP</span> ${result.status}`];
  if (b.decision) lines.push(`<span class="k">decision</span> <span class="${b.decision === "ALLOW" ? "g" : "a"}">${esc(b.decision)}</span>`);
  for (const k of extraKeys) {
    const v = k === "signature" ? b.kora?.signature : b[k];
    if (v !== undefined) lines.push(`<span class="k">${k === "signature" ? "relayer signature" : k}</span>\n${esc(String(v)).slice(0, 90)}`);
  }
  return lines.join("\n");
}
function reasonText(result) { return (result.body?.reasons ?? []).join(" "); }
function ready() {
  const r = D.results;
  document.getElementById("legitLamports").textContent = "250,000,000 lamports";
  document.getElementById("legitJson").innerHTML = jsonPanel(r.legitimate, ["signature"]);
  document.getElementById("hiddenJson").innerHTML = jsonPanel(r.hidden, ["reviewId"]) + `\n<span class="k">reasons</span>\n${esc(reasonText(r.hidden))}`;
  document.getElementById("strangerReason").innerHTML = `<span class="k">reason</span>\n${esc(reasonText(r.stranger))}`;
  document.getElementById("overReason").innerHTML = `<span class="k">reason</span>\n${esc(reasonText(r.overLimit))}\n<span class="k">(3,000,000,000 lamports = 3 SOL, limit 1 SOL)</span>`;
  document.getElementById("ethReason").innerHTML = `<span class="k">reasons (long values shortened)</span>\n` + D.eth.map((s) => esc(s)).join("\n");
  document.getElementById("shotA").src = D.shots.pending;
  document.getElementById("shotB").src = D.shots.approved; document.getElementById("shotC").src = D.shots.token;
}

// ---- review scene (65-84) --------------------------------------------------------------------------
const STEPS = () => [
  [66.4, "1", "The agent's payment is held", "The server returns a review link instead of a signature."],
  [70.6, "2", "A named reviewer opens it", "They see every decoded instruction, including the unknown one."],
  [74.6, "3", "They approve with their own token", "The approval is tied to this exact transaction."],
  [78.4, "4", "The agent retries and is signed", `HTTP ${D.results.hiddenAfterApproval.status}, signed: ${D.results.hiddenAfterApproval.body?.kora?.signature ?? "?"} (a stand-in relayer, for this recording)`],
  [81.2, "5", "The same approval again is refused", `HTTP ${D.results.hiddenReused.status} ${D.results.hiddenReused.body?.error ?? ""}: an approval works once.`]
];
function reviewScene(t) {
  const steps = document.getElementById("steps");
  if (!steps.dataset.built) {
    steps.innerHTML = STEPS().map((s, i) => `<div class="panel step" id="step${i}" style="margin-bottom:18px;opacity:0;padding:22px 30px"><div style="display:flex;gap:22px;align-items:flex-start"><span class="row n" style="padding:0;width:48px;height:48px;border-radius:50%;justify-content:center;flex:none">${s[1]}</span><div><div style="font-size:34px;font-weight:700">${esc(s[2])}</div><div class="small" style="margin-top:4px;word-break:break-all">${esc(s[3])}</div></div></div></div>`).join("");
    steps.dataset.built = "1";
  }
  STEPS().forEach((s, i) => {
    const el = document.getElementById("step" + i);
    const k = ease((t - s[0]) / 0.6);
    el.style.opacity = t >= s[0] ? 1 : 0; el.style.transform = `translateY(${(1 - k) * 22}px)`; el.style.opacity = k;
    const active = t >= s[0] && (i === STEPS().length - 1 || t < STEPS()[i + 1][0]);
    el.style.borderColor = active ? "rgba(74,222,128,.7)" : "";
  });
  // screenshots: pending page until the click at 76.2, approved page after; slow pan down the page
  const A = document.getElementById("shotA"), B = document.getElementById("shotB");
  const sw = 1040, panelH = 760, SC = sw / 1100, OFF = -170;
  const hA = A.naturalHeight ? A.naturalHeight * (sw / A.naturalWidth) : panelH;
  const hB = B.naturalHeight ? B.naturalHeight * (sw / B.naturalWidth) : panelH;
  const pan = () => 0;
  const swap = clamp((t - 76.2) / 0.5);
  const C = document.getElementById("shotC");
  const typed = clamp((t - 74.2) / 0.3);
  A.style.opacity = (1 - typed) * (1 - swap); C.style.opacity = typed * (1 - swap); B.style.opacity = swap;
  A.style.top = pan(hA, (t - 67) / 8) + "px";
  B.style.top = pan(hB, (t - 76.4) / 5) + "px";
  // cursor travels to the Approve button (position taken from the real page), clicks at 76.2
  const cur = document.getElementById("cursor");
  const raw = D.approveXY.map((v) => v * 1100 / 700); // button centre in CSS px of the 1100px-wide page
  const sx = 120 + raw[0] * SC + OFF, sy = 150 + raw[1] * SC;
  const k = ease((t - 72.2) / 3.6);
  cur.style.opacity = t > 72.2 && t < 77.4 ? 1 : 0;
  cur.style.left = (1000 + (sx - 1000) * k) + "px"; cur.style.top = (900 + (sy - 900) * k) + "px";
  const press = t > 76 && t < 76.4 ? 0.85 : 1; cur.style.transform = `scale(${press})`;
}

// ---- pipeline dots (scene 2) -----------------------------------------------------------------------
function dots(t) {
  const pos = (id, a, b, t0, dur, loop) => {
    const el = document.getElementById(id);
    if (t < t0) { el.style.opacity = 0; return; }
    let k = ((t - t0) % (loop ?? dur)) / dur; if (k > 1) { el.style.opacity = 0; return; }
    el.style.opacity = 1; el.style.left = a[0] + (b[0] - a[0]) * k + "px"; el.style.top = a[1] + (b[1] - a[1]) * k + "px";
  };
  pos("dotA", [510, 520], [690, 520], 22.6, 1.1, 3);
  const g = document.getElementById("dotB"), h = document.getElementById("dotC");
  pos("dotB", [1230, 505], [1410, 400], 24.8, 1.1, 3);
  pos("dotC", [1230, 530], [1410, 650], 26, 1.1, 3);
  h.style.background = "var(--amber)"; h.style.boxShadow = "0 0 24px var(--amber)";
}

// ---- stamp pop -------------------------------------------------------------------------------------
function stamps(t) {
  for (const el of document.querySelectorAll(".stamp[data-t]")) {
    const k = clamp((t - Number(el.dataset.t)) / 0.35);
    el.style.transform = `scale(${1 + (1 - ease(k)) * 0.7}) rotate(${(1 - ease(k)) * -6}deg)`;
  }
}

window.render = (t) => {
  if (!window.__ready) { ready(); window.__ready = true; }
  for (const s of scenes) {
    const a = Number(s.dataset.s), b = Number(s.dataset.e);
    const vis = t >= a - 0.001 && t < b;
    s.style.display = vis ? "block" : "none";
    s.style.opacity = vis ? Math.min(clamp((t - a) / 0.5), clamp((b - t) / 0.5)) : 0;
  }
  for (const el of timed) {
    const k = ease((t - Number(el.dataset.t)) / 0.6);
    el.style.opacity = k; el.style.translate = `0 ${(1 - k) * 26}px`;
  }
  stamps(t); dots(t); reviewScene(t);
  const c = CAPTIONS.find(([a, b]) => t >= a && t < b);
  caption.textContent = c ? c[2] : "";
  caption.style.opacity = c ? Math.min(clamp((t - c[0]) / 0.3), clamp((c[1] - t) / 0.3)) : 0;
  bar.style.width = (t / TOTAL) * 1920 + "px";
};
