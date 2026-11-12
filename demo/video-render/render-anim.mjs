// Renders anim/index.html frame by frame (deterministic: every frame is render(t)) and encodes an MP4.
// Usage: PLAYWRIGHT_DIR=<dir with node_modules/playwright> node render-anim.mjs <capture-dir> <evm-approvals.txt> <out-dir> [fps] [seconds]
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [, , capDir, evmTxt, outDir, fpsArg, secArg] = process.argv;
const fps = Number(fpsArg ?? 30), seconds = Number(secArg ?? 110);
const here = import.meta.dirname;
const require = createRequire(path.join(process.env.PLAYWRIGHT_DIR ?? path.resolve(here, "../.."), "x.js"));
const { chromium } = require("playwright");

const data = JSON.parse(readFileSync(`${capDir}/data.json`, "utf8"));
const uri = (f) => `data:image/png;base64,${readFileSync(`${capDir}/${f}`).toString("base64")}`;
const reasonsLine = readFileSync(evmTxt, "utf8").split("\n").filter((l) => l.startsWith("Reasons: ")).pop() ?? "";
const eth = reasonsLine.replace("Reasons: ", "")
  .replace(/\d{60,}/g, "115792…639935 (the maximum)")
  .replace(/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/g, "USDC")
  .replace(/0x3333333333333333333333333333333333333333/g, "0x3333…3333")
  .split(/(?<=\.) (?=[A-Z])/);
const DATA = { ...data, eth, shots: { pending: uri("review-1-pending.png"), token: uri("review-2-token.png"), approved: uri("review-3-approved.png") } };

mkdirSync(`${outDir}/frames`, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.addInitScript((d) => { window.DATA = d; }, DATA);
await page.goto(`file://${here}/anim/index.html`);
await page.evaluate(() => window.render(0));
await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
const frames = Math.round(seconds * fps);
for (let i = 0; i < frames; i++) {
  await page.evaluate((t) => window.render(t), i / fps);
  await page.screenshot({ path: `${outDir}/frames/${String(i).padStart(5, "0")}.jpg`, type: "jpeg", quality: 94 });
  if (i % 300 === 0) console.log(`frame ${i}/${frames}`);
}
await browser.close();
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
execFileSync(ffmpeg, ["-y", "-framerate", String(fps), "-i", `${outDir}/frames/%05d.jpg`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", `${outDir}/agentguard-demo-animated.mp4`], { stdio: "ignore" });
console.log("done", `${outDir}/agentguard-demo-animated.mp4`);
