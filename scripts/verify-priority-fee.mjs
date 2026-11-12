// Checks parseAndDecodeTransaction's priority-fee computation for legacy/v0 transactions against the fee
// the chain actually charged (meta.fee - 5000 x signatures). Read-only. Run `npm run build` first.
//   node scripts/verify-priority-fee.mjs ~/agentguard-corpus [--n 40] [--rpc <url>]
import { createReadStream, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { parseAndDecodeTransaction } from "../dist/src/agent-integration/parse-transaction.js";
import { buildDemoRegistry } from "../dist/demo/policy.js";
import { registerStandardPrograms } from "../dist/src/agent-integration/standard-programs.js";

const argv = process.argv.slice(2);
const dir = (argv.find((a) => !a.startsWith("--")) ?? "~/agentguard-corpus").replace(/^~/, homedir());
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : argv[i + 1]; };
const want = Number(opt("n", 40)), rpc = opt("rpc", "https://api.mainnet-beta.solana.com");
const registry = registerStandardPrograms(buildDemoRegistry());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CB = "ComputeBudget111111111111111111111111111111";

const candidates = [];
for (const f of readdirSync(dir).filter((f) => /^txs-\d+\.jsonl$/.test(f)).sort()) {
  for await (const line of createInterface({ input: createReadStream(join(dir, f)) })) {
    if (candidates.length >= want * 40) break;
    const row = JSON.parse(line);
    if (row.v === 1 || row.e) continue; // v1 is read from config; skip failed transactions
    const tx = VersionedTransaction.deserialize(Buffer.from(row.t, "base64"));
    if (tx.message.addressTableLookups?.length) continue; // keep it offline-decodable
    const keys = tx.message.staticAccountKeys;
    const hasPrice = tx.message.compiledInstructions.some((ix) => keys[ix.programIdIndex].toBase58() === CB && ix.data[0] === 3);
    if (hasPrice && Math.random() < 0.02) candidates.push({ row, tx });
  }
  if (candidates.length >= want * 40) break;
}
let checked = 0, match = 0; const bad = [];
for (const { row, tx } of candidates) {
  if (checked >= want) break;
  const signature = bs58.encode(tx.signatures[0]);
  let reply;
  for (let attempt = 0; attempt < 6 && !reply; attempt++) {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 1 }] }) });
    if (r.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    const body = await r.json(); if (body.error?.code === 429) { await sleep(2000 * (attempt + 1)); continue; }
    reply = body;
  }
  const fee = reply?.result?.meta?.fee;
  if (fee === undefined) continue;
  const charged = BigInt(fee) - 5000n * BigInt(tx.signatures.length);
  const decoded = await parseAndDecodeTransaction(row.t, registry);
  const computed = decoded.priorityFee ?? 0n;
  checked++;
  if (computed === charged) match++; else {
    const keys = tx.message.staticAccountKeys;
    const detail = tx.message.compiledInstructions.map((ix) => {
      const program = keys[ix.programIdIndex].toBase58();
      return program === CB ? `CB:${ix.data[0]}${ix.data[0] === 2 ? "=" + Buffer.from(ix.data).readUInt32LE(1) : ix.data[0] === 3 ? "=" + Buffer.from(ix.data).readBigUInt64LE(1) : ""}` : program.slice(0, 6);
    });
    bad.push({ signature: signature.slice(0, 12), computed: String(computed), charged: String(charged), instructions: detail });
  }
  await sleep(400);
}
console.log(JSON.stringify({ checked, exactMatches: match, mismatches: bad.length, samples: bad.slice(0, 5) }, null, 2));
