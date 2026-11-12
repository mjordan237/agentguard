// Collects real mainnet transactions (votes excluded) into a local JSONL corpus for offline replay.
// Read-only: it only calls getSlot/getBlock. Nothing is sent on chain.
//
//   node scripts/corpus-collect.mjs --out ~/agentguard-corpus --target 1000000
//   options: --concurrency 3  --rpc <url>  --start-slot <n> (default: finalized - 100, walking backwards)
//
// Output: <out>/txs-00000.jsonl ... (100k lines each) and <out>/progress.json. Re-running resumes.
// Line format: {"s":slot,"i":indexInBlock,"v":"legacy"|0|1,"e":0|1 (failed on chain),"t":"<base64 tx>"}
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VersionedTransaction } from "@solana/web3.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const outDir = (args.out ?? "~/agentguard-corpus").replace(/^~/, homedir());
const target = Number(args.target ?? 1_000_000);
const concurrency = Number(args.concurrency ?? 3);
const rpcUrl = args.rpc ?? "https://api.mainnet-beta.solana.com";
const LINES_PER_FILE = 100_000;
const VOTE_PROGRAM = "Vote111111111111111111111111111111111111111";

mkdirSync(outDir, { recursive: true });
const progressPath = join(outDir, "progress.json");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, params) {
  // The public endpoint rate-limits hard. Never give up on a slot: back off (capped) and retry, so
  // one throttled request cannot kill a multi-hour collection.
  for (let attempt = 0; ; attempt++) {
    let response, body;
    try {
      response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
      if (response.status === 429 || response.status >= 500) body = null;
      else body = await response.json(); // inside the try: a timeout while reading the body must retry too
    } catch {
      await sleep(Math.min(1000 * 2 ** attempt, 60_000));
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      await sleep(Math.min(1500 * 2 ** attempt, 60_000));
      continue;
    }
    // Some endpoints return the rate limit as a JSON-RPC error instead of an HTTP status.
    if (body.error?.code === 429) {
      await sleep(Math.min(1500 * 2 ** attempt, 60_000));
      continue;
    }
    return body;
  }
}

let state = existsSync(progressPath) ? JSON.parse(readFileSync(progressPath, "utf8")) : null;
if (!state) {
  const slot = args["start-slot"] ? Number(args["start-slot"]) : (await rpc("getSlot", [{ commitment: "finalized" }])).result - 100;
  state = { nextSlot: slot, startSlot: slot, collected: 0, blocks: 0, skippedSlots: 0, votesSkipped: 0, unparseable: 0, versions: {}, firstSlot: slot, lastSlot: slot };
}

let maxVersion = 1;
function filePath(n) { return join(outDir, `txs-${String(Math.floor(n / LINES_PER_FILE)).padStart(5, "0")}.jsonl`); }

async function fetchBlock(slot) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const reply = await rpc("getBlock", [slot, { encoding: "base64", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: maxVersion, commitment: "finalized" }]);
    if (reply.result) return reply.result;
    const code = reply.error?.code;
    if (code === -32015) {
      const wanted = Number(/maxSupportedTransactionVersion"?:\s*(\d+)/.exec(reply.error.message)?.[1]);
      if (Number.isInteger(wanted) && wanted > maxVersion) { maxVersion = wanted; continue; }
    }
    if (code === -32007 || code === -32009) return null; // skipped slot or not in storage
    await sleep(1000 * 2 ** attempt);
  }
  return null;
}

function absorb(block, slot) {
  const lines = [];
  block.transactions.forEach((entry, index) => {
    const version = String(entry.version);
    let tx;
    try { tx = VersionedTransaction.deserialize(Buffer.from(entry.transaction[0], "base64")); } catch { state.unparseable++; return; }
    const msg = tx.message;
    const keys = msg.staticAccountKeys;
    const isVote = msg.compiledInstructions.some((ix) => keys[ix.programIdIndex]?.toBase58() === VOTE_PROGRAM);
    if (isVote) { state.votesSkipped++; return; }
    state.versions[version] = (state.versions[version] ?? 0) + 1;
    lines.push(JSON.stringify({ s: slot, i: index, v: entry.version, e: entry.meta?.err ? 1 : 0, t: entry.transaction[0] }));
  });
  return lines;
}

const startedAt = Date.now();
let inFlight = 0;
let slotsIssued = state.nextSlot;
const pending = new Map(); // slot -> lines | null, flushed in slot order (descending)
let nextToFlush = state.nextSlot;

function flush() {
  while (pending.has(nextToFlush)) {
    const lines = pending.get(nextToFlush);
    pending.delete(nextToFlush);
    if (lines === null) state.skippedSlots++;
    else {
      for (const line of lines) {
        appendFileSync(filePath(state.collected), line + "\n");
        state.collected++;
      }
      state.blocks++;
      state.lastSlot = nextToFlush;
    }
    nextToFlush--;
    state.nextSlot = nextToFlush;
  }
  writeFileSync(progressPath, JSON.stringify(state));
}

async function worker() {
  while (state.collected + inFlight * 300 < target + concurrency * 300) {
    const slot = slotsIssued--;
    inFlight++;
    try {
      const block = await fetchBlock(slot);
      pending.set(slot, block ? absorb(block, slot) : null);
    } finally {
      inFlight--;
    }
    flush();
    if (state.blocks % 25 === 0) {
      const secs = (Date.now() - startedAt) / 1000;
      console.log(`${state.collected} txs from ${state.blocks} blocks (${(state.collected / Math.max(secs, 1)).toFixed(0)} tx/s) skipped slots ${state.skippedSlots} maxVersion ${maxVersion}`);
    }
    if (state.collected >= target) return;
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
flush();
console.log(`DONE ${state.collected} txs, ${state.blocks} blocks, slots ${state.firstSlot}..${state.lastSlot}, versions ${JSON.stringify(state.versions)}, votes skipped ${state.votesSkipped}, unparseable ${state.unparseable}`);
