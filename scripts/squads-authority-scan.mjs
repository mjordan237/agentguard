// Read-only scan: who holds each Solana program's upgrade authority, and is it a Squads multisig?
//
// Usage: node scripts/squads-authority-scan.mjs scripts/squads-scan-programs.csv [--json]
//   RPC_URL=<mainnet rpc>   defaults to the public mainnet endpoint (rate limited; use your own for long lists)
//
// Input CSV: name,programId   (lines starting with # are ignored)
//
// Classification, per program:
//   IMMUTABLE        upgrade authority removed
//   SINGLE_KEY       authority is an ordinary keypair address (on the ed25519 curve)
//   SQUADS_V4/V3     authority is off-curve AND a recent transaction touching it also invoked the Squads program
//   OTHER_PDA        off-curve authority with no Squads evidence in the sampled transactions
//   NOT_UPGRADEABLE  account is not owned by the upgradeable loader
//   NOT_FOUND        no such account
//   ERROR            RPC failure after retries
//
// SQUADS_* is evidence from sampled transactions, not proof. OTHER_PDA may still be Squads
// if the sampled transactions were old or unrelated. Nothing here sends a transaction.
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const SQUADS = {
  SQUADS_V4: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf",
  SQUADS_V3: "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu"
};
const SAMPLE_SIGNATURES = 5;

const [csvPath, ...flags] = process.argv.slice(2);
if (!csvPath) {
  console.error("Usage: node scripts/squads-authority-scan.mjs <programs.csv> [--json]");
  process.exit(1);
}
const asJson = flags.includes("--json");
const connection = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(label, run) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`${label}: ${lastError?.message ?? lastError}`);
}

function readProgram(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [name, programId] = line.split(",").map((part) => part.trim());
      return { name, programId };
    });
}

async function readUpgradeAuthority(programId) {
  const program = await withRetry("getAccountInfo(program)", () => connection.getAccountInfo(new PublicKey(programId)));
  if (!program) return { kind: "NOT_FOUND" };
  if (!program.owner.equals(UPGRADEABLE_LOADER)) return { kind: "NOT_UPGRADEABLE", detail: `owner ${program.owner.toBase58()}` };

  // UpgradeableLoaderState::Program = enum tag 2 (u32 LE), then the ProgramData address.
  if (program.data.length < 36 || program.data.readUInt32LE(0) !== 2) return { kind: "NOT_UPGRADEABLE", detail: "unexpected program account layout" };
  const programData = new PublicKey(program.data.subarray(4, 36));

  const data = await withRetry("getAccountInfo(programdata)", () => connection.getAccountInfo(programData));
  if (!data) return { kind: "NOT_FOUND", detail: "program data account missing" };
  // UpgradeableLoaderState::ProgramData = tag 3 (u32), slot u64, Option<Pubkey> (1-byte tag + 32).
  if (data.data.length < 13 || data.data.readUInt32LE(0) !== 3) return { kind: "NOT_UPGRADEABLE", detail: "unexpected program data layout" };
  if (data.data[12] === 0) return { kind: "IMMUTABLE" };
  return { kind: "HAS_AUTHORITY", authority: new PublicKey(data.data.subarray(13, 45)) };
}

async function squadsEvidence(authority) {
  const signatures = await withRetry("getSignaturesForAddress", () =>
    connection.getSignaturesForAddress(authority, { limit: SAMPLE_SIGNATURES })
  );
  for (const { signature, err } of signatures) {
    if (err) continue;
    await sleep(250);
    const transaction = await withRetry("getTransaction", () =>
      connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 })
    );
    if (!transaction) continue;
    const message = transaction.transaction.message;
    const keys = [
      ...message.getAccountKeys({ accountKeysFromLookups: transaction.meta?.loadedAddresses }).keySegments().flat()
    ].map((key) => key.toBase58());
    for (const [label, id] of Object.entries(SQUADS)) {
      if (keys.includes(id)) return { label, signature };
    }
  }
  return { label: undefined, sampled: signatures.length };
}

async function scan({ name, programId }) {
  try {
    const result = await readUpgradeAuthority(programId);
    if (result.kind !== "HAS_AUTHORITY") return { name, programId, ...result };
    const authority = result.authority;
    if (PublicKey.isOnCurve(authority.toBytes())) {
      return { name, programId, kind: "SINGLE_KEY", authority: authority.toBase58() };
    }
    const evidence = await squadsEvidence(authority);
    return evidence.label
      ? { name, programId, kind: evidence.label, authority: authority.toBase58(), evidence: evidence.signature }
      : { name, programId, kind: "OTHER_PDA", authority: authority.toBase58(), detail: `${evidence.sampled} recent signatures sampled, no Squads program` };
  } catch (error) {
    return { name, programId, kind: "ERROR", detail: error.message };
  }
}

const results = [];
for (const entry of readProgram(readFileSync(csvPath, "utf8"))) {
  results.push(await scan(entry));
  await sleep(300);
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  console.log("| Name | Program | Result | Upgrade authority | Evidence / note |");
  console.log("|---|---|---|---|---|");
  for (const r of results) {
    console.log(`| ${r.name} | ${r.programId} | ${r.kind} | ${r.authority ?? ""} | ${r.evidence ?? r.detail ?? ""} |`);
  }
  const counts = {};
  for (const r of results) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  console.error(`\nSummary: ${JSON.stringify(counts)}`);
}
