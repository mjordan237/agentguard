// Captures the real product for the animated video: starts dist/demo/live-flow.js (real server, stand-in
// relayer), sends four transactions through the real API, and drives the real review page in a browser.
// Usage: PLAYWRIGHT_DIR=<dir containing node_modules/playwright> node capture.mjs <out-dir>
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const out = path.resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const repo = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR ?? repo, "x.js"));
const { chromium } = require("playwright");

const server = spawn("node", ["dist/demo/live-flow.js", "4777"], { cwd: repo, stdio: ["ignore", "pipe", "inherit"] });
const info = await new Promise((resolve, reject) => {
  let buf = "";
  server.stdout.on("data", (d) => { buf += d; const line = buf.split("\n").find((l) => l.startsWith("{")); if (line) resolve(JSON.parse(line)); });
  server.on("exit", (c) => reject(new Error(`live-flow exited ${c}`)));
});

const call = async (pathname, body, method = "POST") => {
  const r = await fetch(info.baseUrl + pathname, { method, headers: { "content-type": "application/json", authorization: `Bearer ${info.apiKey}` }, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => undefined) };
};
const send = (name, extra = {}) => call("/gate-and-sign", { agentId: info.agentId, policyId: info.policyId, transactionBase64: info.transactions[name], ...extra });

const data = { addresses: info.addresses, results: {} };
let browser;
try {
  for (const name of ["legitimate", "hidden", "stranger", "overLimit"]) data.results[name] = await send(name);

  const review = data.results.hidden.body;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(review.reviewUrl);
  await page.locator("#token").fill(info.reviewerToken);
  await page.locator('#login button[type="submit"]').click();
  await page.locator("#detail .actions").waitFor();
  await page.screenshot({ path: `${out}/review-1-pending.png`, fullPage: true });
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  const box = await approve.boundingBox();
  data.approveXY = [(box.x + box.width / 2) * (700 / 1100), (box.y + box.height / 2) * (700 / 1100)];
  await approve.click();
  await page.screenshot({ path: `${out}/review-2-token.png`, fullPage: true });
  await page.getByRole("button", { name: "Confirm approval", exact: true }).click();
  await page.getByText("You approved this review.", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/review-3-approved.png`, fullPage: true });
  data.approvedPageText = (await page.locator("body").innerText()).slice(0, 600);

  data.results.hiddenAfterApproval = await send("hidden", { reviewId: review.reviewId });
  data.results.hiddenReused = await send("hidden", { reviewId: review.reviewId });
} finally {
  try { await browser?.close(); } finally { server.kill(); }
}
writeFileSync(`${out}/data.json`, JSON.stringify(data, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(data.results).map(([k, v]) => [k, [v.status, v.body?.decision ?? v.body?.code ?? Object.keys(v.body ?? {})]])), null, 1));
