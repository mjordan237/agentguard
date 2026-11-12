// HTTP load test: runs the real AgentGuard server (SQLite persistence on) as a child process and
// POSTs corpus transactions to /evaluate. Measures what corpus-replay.mjs cannot: HTTP, JSON, SQLite
// writes, review creation. Run `npm run build` first.
//   node scripts/corpus-load.mjs ~/agentguard-corpus --alts alts.json --count 100000 --concurrency 32 --db /path/load.db
import { fork } from "node:child_process";
import { createReadStream, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

if (process.argv[2] === "--server") {
  const { createServer } = await import("../dist/src/api/server.js");
  const { buildDemoPolicy, buildDemoRegistry } = await import("../dist/demo/policy.js");
  const { PublicKey, AddressLookupTableAccount } = await import("@solana/web3.js");
  const alts = new Map();
  if (process.env.ALTS) for (const [a, b64] of Object.entries(JSON.parse(readFileSync(process.env.ALTS, "utf8")))) alts.set(a, new AddressLookupTableAccount({ key: new PublicKey(a), state: AddressLookupTableAccount.deserialize(Buffer.from(b64, "base64")) }));
  const HIGH = "1000000000000000";
  const policy = { ...buildDemoPolicy([], HIGH, HIGH), maxPriorityFeePerTransaction: "1000" };
  const app = createServer(new Map([["demo", policy]]), buildDemoRegistry(), {
    baseUrl: "http://localhost", persistencePath: process.env.DB, rateLimit: { maxRequests: 1e9, windowMs: 60_000 },
    resolveLookupTable: async (k) => alts.get(k.toBase58()) ?? null
  });
  app.listen(Number(process.env.PORT), () => process.send("ready"));
} else {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
  const dir = (argv.find((a) => !a.startsWith("--")) ?? "~/agentguard-corpus").replace(/^~/, homedir());
  const count = Number(opt("count", 100000)), concurrency = Number(opt("concurrency", 32));
  const db = opt("db"), port = 4399;
  const child = fork(fileURLToPath(import.meta.url), ["--server"], { env: { ...process.env, DB: db, PORT: String(port), ALTS: opt("alts", "") ? opt("alts").replace(/^~/, homedir()) : "" } });
  await new Promise((r) => child.once("message", r));

  // sample evenly across the corpus
  const files = readdirSync(dir).filter((f) => /^txs-\d+\.jsonl$/.test(f)).sort();
  const total = Number(opt("corpus-size", 1000000));
  const stride = Math.max(1, Math.floor(total / count));
  const txs = []; let n = 0;
  for (const f of files) for await (const line of createInterface({ input: createReadStream(join(dir, f)) })) { if (n++ % stride === 0 && txs.length < count) txs.push(JSON.parse(line).t); }
  console.log(`sending ${txs.length} transactions at concurrency ${concurrency}`);

  const lat = [], status = {}, decision = {}; let next = 0, errors = 0;
  const t0 = Date.now();
  async function worker() {
    while (next < txs.length) {
      const t = txs[next++];
      const s = process.hrtime.bigint();
      try {
        const r = await fetch(`http://localhost:${port}/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "load", policyId: "demo", transactionBase64: t }) });
        const body = await r.json();
        status[r.status] = (status[r.status] ?? 0) + 1;
        if (body.decision) decision[body.decision] = (decision[body.decision] ?? 0) + 1;
      } catch { errors++; }
      lat.push(Number(process.hrtime.bigint() - s) / 1e6);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const secs = (Date.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  const p = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))].toFixed(1) + " ms";
  const rss = await (async () => { try { return null; } catch { return null; } })();
  console.log(JSON.stringify({ sent: txs.length, seconds: secs.toFixed(1), reqPerSecond: Math.round(txs.length / secs), status, decision, networkErrors: errors, p50: p(0.5), p99: p(0.99), max: p(1), dbBytes: existsSync(db) ? statSync(db).size : 0 }, null, 2));
  child.kill();
}
