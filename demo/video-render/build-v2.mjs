// Builds agentguard-demo-video-v2.mp4 from a fresh run of the real demo scripts.
// Usage: node build-v2.mjs <dir-with-captured-run-output> <out-dir>
// Terminal pages are the captured output, only line-wrapped (no words changed).
// Intro/explainer/outro cards are short text grounded in what the pages show.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , runDir, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });
const WRAP = 96;

function wrap(text) {
  const out = [];
  for (const raw of text.replace(/\n+$/, "").split("\n")) {
    const indent = raw.match(/^ */)[0].length;
    const lead = /^(Reasons?|Decision): /.test(raw) ? 9 : indent + 2;
    let line = raw;
    let first = true;
    while (line.length > WRAP) {
      // break at the last comma/space before WRAP, else hard-break (long digit runs)
      let cut = Math.max(line.lastIndexOf(" ", WRAP), line.lastIndexOf(",", WRAP - 1) + 1);
      if (cut <= lead + 8) cut = WRAP;
      out.push(line.slice(0, cut).replace(/\s+$/, ""));
      line = " ".repeat(first ? lead : lead) + line.slice(cut).replace(/^\s+/, "");
      first = false;
    }
    out.push(line);
  }
  return out.join("\n");
}

const pages = [
  { cue: "AgentGuard", body: "Checks what an AI agent is about to sign, before it signs.\n\nIt reads every instruction in a Solana transaction, and every\nEthereum transaction or permit, and compares it with the\ncustomer's own rules. Allowed goes through. Anything unusual or\nunreadable goes to a person.", secs: 7 },
  { cue: "$ node dist/demo/legitimate-payment.js", file: "legitimate-payment.txt", secs: 9 },
  { cue: "$ node dist/demo/adversarial-payment.js", file: "adversarial-payment.txt", secs: 12 },
  { cue: "Why it's caught", body: "The second instruction moves no money, so a balance check\nwould pass it. AgentGuard cannot read it, so it does not guess:\nthe whole transaction goes to a person.", secs: 6 },
  { cue: "$ node dist/demo/unapproved-destination-payment.js", file: "unapproved-destination-payment.txt", secs: 9 },
  { cue: "$ node dist/demo/over-limit-payment.js", file: "over-limit-payment.txt", secs: 9 },
  { cue: "Same checks on Ethereum", body: "An agent is asked to approve USDC spending.\nFirst a bounded approval to a listed vendor,\nthen an unlimited approval to a spender nobody listed.", secs: 5 },
  { cue: "$ node dist/demo/evm-approvals.js", file: "evm-approvals.txt", secs: 20 },
  { cue: "AgentGuard", body: "Every one of those is held for a person instead of being\nsigned or silently blocked.\n\nOpen source. elyzion.pro", secs: 6 }
];

const clips = [];
pages.forEach((p, i) => {
  const body = p.file ? wrap(readFileSync(`${runDir}/${p.file}`, "utf8")) : p.body;
  writeFileSync(`${outDir}/cue${i}.txt`, p.cue);
  writeFileSync(`${outDir}/body${i}.txt`, body);
  execFileSync("node", ["make-page.mjs", `v2-${i}`, `${outDir}/cue${i}.txt`, `${outDir}/body${i}.txt`, `${outDir}/page${i}.png`], { stdio: "inherit" });
  execFileSync("ffmpeg", ["-y", "-loop", "1", "-i", `${outDir}/page${i}.png`, "-t", String(p.secs), "-r", "30", "-pix_fmt", "yuv420p", "-c:v", "libx264", `${outDir}/clip${i}.mp4`], { stdio: "ignore" });
  clips.push(`file 'clip${i}.mp4'`);
});
writeFileSync(`${outDir}/concat-list.txt`, clips.join("\n") + "\n");
execFileSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", `${outDir}/concat-list.txt`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", `${outDir}/agentguard-demo-video-v2.mp4`], { stdio: "ignore" });
console.log("done", `${outDir}/agentguard-demo-video-v2.mp4`);
