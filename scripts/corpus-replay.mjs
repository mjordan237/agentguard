// Replays a corpus of real mainnet transactions (from corpus-collect.mjs) through AgentGuard's
// decode + policy path, offline, and checks it against an independent oracle. Run `npm run build` first.
//
//   node scripts/corpus-replay.mjs ~/agentguard-corpus [--limit N] [--alts alts.json] [--json report.json]
//
// What it measures:
//   * crashes: any exception from parseAndDecodeTransaction / evaluatePolicy, grouped by message
//   * decisions per message version, and how instructions decode (interpolated / fallback / raw_dump)
//   * throughput and per-transaction latency (single thread, no network)
//   * SAFETY ORACLE: for every transaction AgentGuard ALLOWs, an independent web3.js decode must show
//     it contains only System-program transfers, at least one instruction, and a priority fee within
//     the policy limit. Any violation is a false ALLOW and fails the run (exit code 2).
//   * DECODE ORACLE: AgentGuard's decoded transfer amount and destination must equal web3.js's own
//     SystemInstruction.decodeTransfer for the same instruction.
//
// Policy used: only the System program allowed, any destination, high amount caps, priority fee capped
// at 1000 lamports -- chosen to give the ALLOW path real traffic, not to model a customer.
import { createReadStream, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AddressLookupTableAccount, PublicKey, SystemInstruction, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { parseAndDecodeTransaction } from "../dist/src/agent-integration/parse-transaction.js";
import { evaluatePolicy } from "../dist/src/policy/evaluate.js";
import { buildDemoPolicy, buildDemoRegistry } from "../dist/demo/policy.js";
import { registerStandardPrograms } from "../dist/src/agent-integration/standard-programs.js";

const argv = process.argv.slice(2);
const dir = (argv.find((a) => !a.startsWith("--")) ?? "~/agentguard-corpus").replace(/^~/, homedir());
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i === -1 ? undefined : argv[i + 1]; };
const limit = opt("limit") ? Number(opt("limit")) : Infinity;
const altsPath = opt("alts");
const MAX_PRIORITY_FEE = 1000n;
const HIGH = "1000000000000000";

// --- Address Lookup Tables from an offline cache (address -> base64 account data) ---
const altCache = new Map();
if (altsPath && existsSync(altsPath)) {
  for (const [address, b64] of Object.entries(JSON.parse(readFileSync(altsPath, "utf8")))) {
    const key = new PublicKey(address);
    altCache.set(address, new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(Buffer.from(b64, "base64")) }));
  }
}
const resolveLookupTable = async (address) => altCache.get(address.toBase58()) ?? null;

const registry = registerStandardPrograms(buildDemoRegistry());
const SYSTEM = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const policy = { ...buildDemoPolicy([], HIGH, HIGH), allowAnyDestination: true, programAllowlist: [SYSTEM, COMPUTE_BUDGET], maxPriorityFeePerTransaction: String(MAX_PRIORITY_FEE) };
// Programs the runtime treats as built-in when sizing the default compute budget (3,000 units, not 200,000).
const BUILTIN = new Set([SYSTEM, COMPUTE_BUDGET, "Vote111111111111111111111111111111111111111", "Stake11111111111111111111111111111111111111", "Config1111111111111111111111111111111111111", "BPFLoader1111111111111111111111111111111111", "BPFLoader2111111111111111111111111111111111", "BPFLoaderUpgradeab1e11111111111111111111111", "LoaderV411111111111111111111111111111111111", "AddressLookupTab1e1111111111111111111111111"]);

// --- independent oracle (web3.js only; shares no AgentGuard code) ---
function oracle(rawBase64) {
  const tx = VersionedTransaction.deserialize(Buffer.from(rawBase64, "base64"));
  const message = tx.message;
  const lookups = message.addressTableLookups ?? [];
  const tables = [];
  for (const lookup of lookups) {
    const table = altCache.get(lookup.accountKey.toBase58());
    if (!table) return { resolvable: false };
    tables.push(table);
  }
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables });
  const transfers = [];
  let onlySystemTransfers = message.compiledInstructions.some((c) => keys.get(c.programIdIndex)?.toBase58() === SYSTEM);
  let price = 0n, limit;
  const programs = message.compiledInstructions.map((c) => keys.get(c.programIdIndex)?.toBase58());
  for (const compiled of message.compiledInstructions) {
    const programId = keys.get(compiled.programIdIndex);
    if (programId?.toBase58() === COMPUTE_BUDGET) {
      const d = Buffer.from(compiled.data);
      if (d[0] === 3 && d.length >= 9) price = d.readBigUInt64LE(1);
      if (d[0] === 2 && d.length >= 5) limit = BigInt(d.readUInt32LE(1));
      transfers.push(undefined);
      continue; // budget instructions move no value
    }
    let transfer;
    if (programId?.toBase58() === SYSTEM && compiled.data.length === 12 && compiled.data[0] === 2 && compiled.data.subarray(1, 4).every((b) => b === 0)) {
      try {
        const instruction = new TransactionInstruction({
          programId,
          keys: compiled.accountKeyIndexes.map((i) => ({ pubkey: keys.get(i), isSigner: false, isWritable: true })),
          data: Buffer.from(compiled.data)
        });
        transfer = SystemInstruction.decodeTransfer(instruction);
      } catch { /* not a well-formed transfer */ }
    }
    if (!transfer) onlySystemTransfers = false;
    transfers.push(transfer);
  }
  let priorityFee;
  if (tx.version === 1) priorityFee = BigInt(message.transactionConfig?.priorityFee ?? 0);
  else {
    const dflt = programs.reduce((n, p) => n + (BUILTIN.has(p) ? 3000n : 200000n), 0n);
    const units = limit ?? (dflt > 1400000n ? 1400000n : dflt);
    priorityFee = price === 0n ? 0n : (units * price + 999999n) / 1000000n;
  }
  return { resolvable: true, onlySystemTransfers, priorityFeeOk: priorityFee <= MAX_PRIORITY_FEE, transfers, version: tx.version };
}

// --- replay ---
const files = readdirSync(dir).filter((f) => /^txs-\d+\.jsonl$/.test(f)).sort();
const counts = { total: 0, failedOnChain: 0 };
const byVersion = {};
const decisions = {};
const modes = { interpolated: 0, fallback: 0, raw_dump: 0 };
const crashes = {};
const crashSamples = {};
const falseAllows = [];
const decodeMismatches = [];
let oracleUnresolvable = 0, allowChecked = 0, transfersCompared = 0, falseReviews = 0;
const falseReviewReasons = {};
const latencies = [];
const t0 = process.hrtime.bigint();

outer: for (const file of files) {
  const lines = createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    if (counts.total >= limit) break outer;
    const row = JSON.parse(line);
    counts.total++;
    if (row.e) counts.failedOnChain++;
    const version = String(row.v);
    byVersion[version] ??= { total: 0, ALLOW: 0, NEEDS_REVIEW: 0, CRASH: 0 };
    byVersion[version].total++;

    let decoded, evaluation;
    const start = process.hrtime.bigint();
    try {
      decoded = await parseAndDecodeTransaction(row.t, registry, resolveLookupTable);
      evaluation = evaluatePolicy(decoded, policy);
    } catch (error) {
      const key = String(error?.message ?? error).slice(0, 90);
      crashes[key] = (crashes[key] ?? 0) + 1;
      crashSamples[key] ??= { slot: row.s, i: row.i };
      byVersion[version].CRASH++;
      continue;
    }
    latencies.push(Number(process.hrtime.bigint() - start));
    decisions[evaluation.decision] = (decisions[evaluation.decision] ?? 0) + 1;
    byVersion[version][evaluation.decision]++;
    for (const instruction of decoded.instructions) modes[instruction.mode]++;

    const truth = oracle(row.t);
    if (!truth.resolvable) { oracleUnresolvable++; if (evaluation.decision === "ALLOW") falseAllows.push({ slot: row.s, i: row.i, why: "ALLOW on a transaction the oracle could not resolve" }); continue; }

    if (evaluation.decision === "ALLOW") {
      allowChecked++;
      if (!(truth.onlySystemTransfers && truth.priorityFeeOk)) {
        falseAllows.push({ slot: row.s, i: row.i, v: version, onlySystemTransfers: truth.onlySystemTransfers, priorityFeeOk: truth.priorityFeeOk });
      }
    } else if (truth.onlySystemTransfers && truth.priorityFeeOk) {
      falseReviews++;
      for (const reason of evaluation.reasons) { const k = reason.replace(/[1-9A-HJ-NP-Za-km-z]{32,44}/g, "<addr>").replace(/\d+/g, "N"); falseReviewReasons[k] = (falseReviewReasons[k] ?? 0) + 1; }
    }

    // decode oracle: compare every transfer AgentGuard decoded with web3.js's own decode, in order
    if (decoded.instructions.length === truth.transfers.length) {
      decoded.instructions.forEach((instruction, index) => {
        const expected = truth.transfers[index];
        if (!expected || instruction.mode === "raw_dump") return;
        transfersCompared++;
        if (instruction.amount !== BigInt(expected.lamports) || instruction.destination !== expected.toPubkey.toBase58()) {
          if (decodeMismatches.length < 20) decodeMismatches.push({ slot: row.s, i: row.i, agentguard: { amount: String(instruction.amount), destination: instruction.destination }, web3: { amount: String(expected.lamports), destination: expected.toPubkey.toBase58() } });
        }
      });
    }
  }
}

const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
latencies.sort((a, b) => a - b);
const pct = (p) => latencies.length ? (latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] / 1e3).toFixed(1) + " us" : "n/a";
const report = {
  corpus: { dir, files: files.length, transactions: counts.total, failedOnChainShare: (counts.failedOnChain / Math.max(counts.total, 1)).toFixed(3) },
  altTablesLoaded: altCache.size,
  byVersion,
  decisions,
  instructionModes: modes,
  crashes,
  crashSamples,
  throughput: { seconds: Number(seconds.toFixed(1)), txPerSecond: Math.round(counts.total / Math.max(seconds, 0.001)), latencyP50: pct(0.5), latencyP99: pct(0.99), latencyMax: pct(1) },
  peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
  safetyOracle: { allowChecked, falseAllows: falseAllows.length, falseAllowSamples: falseAllows.slice(0, 10), oracleUnresolvable },
  decodeOracle: { transfersCompared, mismatches: decodeMismatches.length, samples: decodeMismatches.slice(0, 5) },
  falseReviewsOfPlainTransfers: falseReviews,
  falseReviewReasons
};
console.log(JSON.stringify(report, null, 2));
if (opt("json")) writeFileSync(opt("json"), JSON.stringify(report, null, 2));
if (falseAllows.length > 0 || decodeMismatches.length > 0 || Object.keys(crashes).length > 0) process.exitCode = 2;
