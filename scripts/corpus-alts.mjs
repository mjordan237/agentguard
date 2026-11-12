// Builds an offline Address Lookup Table cache for a corpus, so corpus-replay.mjs can resolve the
// ~20% of transactions that use tables. Read-only (getMultipleAccounts).
//
//   node scripts/corpus-alts.mjs ~/agentguard-corpus ~/agentguard-corpus/alts.json [--rpc <url>]
//
// Tables are fetched at their CURRENT state. Tables are append-only while active, so the current
// state is a superset of what the transaction saw; a table closed since is reported as missing and
// those transactions stay unresolved (AgentGuard fails closed on them, as it would live).
import { createReadStream, readdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";

const [dirArg, outArg, ...rest] = process.argv.slice(2);
const dir = (dirArg ?? "~/agentguard-corpus").replace(/^~/, homedir());
const outPath = (outArg ?? join(dir, "alts.json")).replace(/^~/, homedir());
const rpcUrl = rest[rest.indexOf("--rpc") + 1] && rest.includes("--rpc") ? rest[rest.indexOf("--rpc") + 1] : "https://api.mainnet-beta.solana.com";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cache = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
const wanted = new Set();
let transactions = 0, withTables = 0;
for (const file of readdirSync(dir).filter((f) => /^txs-\d+\.jsonl$/.test(f)).sort()) {
  for await (const line of createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity })) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; } // a half-written last line while collecting
    transactions++;
    const lookups = VersionedTransaction.deserialize(Buffer.from(row.t, "base64")).message.addressTableLookups ?? [];
    if (lookups.length) withTables++;
    for (const lookup of lookups) { const address = lookup.accountKey.toBase58(); if (!(address in cache)) wanted.add(address); }
  }
}
console.log(`${transactions} transactions, ${withTables} use tables, ${wanted.size} tables to fetch (${Object.keys(cache).length} already cached)`);

async function rpc(method, params) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
      if (response.status === 429 || response.status >= 500) { await sleep(1500 * 2 ** Math.min(attempt, 5)); continue; }
      return response.json();
    } catch { await sleep(1000 * 2 ** Math.min(attempt, 5)); }
  }
  throw new Error("RPC kept failing");
}

const addresses = [...wanted];
let missing = 0;
for (let i = 0; i < addresses.length; i += 100) {
  const batch = addresses.slice(i, i + 100);
  const reply = await rpc("getMultipleAccounts", [batch, { encoding: "base64", commitment: "finalized" }]);
  (reply.result?.value ?? []).forEach((account, index) => {
    if (account?.data?.[0]) cache[batch[index]] = account.data[0];
    else missing++;
  });
  if ((i / 100) % 10 === 0) console.log(`fetched ${Math.min(i + 100, addresses.length)}/${addresses.length}`);
  await sleep(200);
}
writeFileSync(outPath, JSON.stringify(cache));
console.log(`wrote ${Object.keys(cache).length} tables to ${outPath}; ${missing} not found (closed or never existed)`);
