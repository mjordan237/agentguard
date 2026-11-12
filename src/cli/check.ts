#!/usr/bin/env node
/**
 * Offline policy checker: runs the same decoder and policy evaluator as the server on a policy file and one
 * transaction, and prints the decision. No server, no network, no keys.
 *
 *   node dist/src/cli/check.js --policy policy.json --tx <base64>
 *   node dist/src/cli/check.js --policy policy.json --tx-file tx.b64
 *   node dist/src/cli/check.js --policy policy.json --evm-tx tx.json
 *
 * Exit code: 0 = ALLOW, 2 = NEEDS_REVIEW, 1 = bad input (so it can gate a CI job).
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { DecodedTransactionSummary } from "../policy/types.js";
import type { EvmTransaction } from "../evm/decode.js";
import { CheckInputError, parseEvmTx as parseEvmObject, runCheck, type CheckInput, type CheckResult } from "../check/engine.js";

export { policyNotes } from "../check/engine.js";

const USAGE = `AgentGuard policy checker

Usage:
  check --policy <policy.json> --tx <base64>            a Solana transaction
  check --policy <policy.json> --tx-file <file>         the same, base64 read from a file
  check --policy <policy.json> --evm-tx <tx.json>       an EVM transaction: {"chainId":1,"from":"0x..","to":"0x..","value":"0","data":"0x.."}

Options:
  --spent <asset=amount,...>   what has already been spent today, e.g. native=2000000000 (default: nothing)
  --lookup-tables <file>       address lookup tables as {"<table>": ["<address>", ...]}, for example the
                               "lookupTables" a sandbox API response returned
  --json                       print the full result as JSON, including the receipt
  --help                       this text

Exit code: 0 ALLOW, 2 NEEDS_REVIEW, 1 bad input.
A Solana transaction that uses an Address Lookup Table is held unless --lookup-tables supplies it: this tool
has no network. The receipt's resultHash matches the one the sandbox API returns for the same input.`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Parses "native=100,TokenMint=5" into bigint amounts. Throws on anything that is not a whole number. */
export function parseSpent(text: string | undefined): Record<string, bigint> {
  const spent: Record<string, bigint> = {};
  if (text === undefined || text.trim() === "") return spent;
  for (const part of text.split(",")) {
    const [asset, amount, ...rest] = part.split("=");
    if (!asset || amount === undefined || rest.length > 0 || !/^\d+$/.test(amount.trim())) {
      throw new Error(`--spent entries must look like asset=123456, got "${part}".`);
    }
    spent[asset.trim()] = BigInt(amount.trim());
  }
  return spent;
}

/** Reads the EVM transaction JSON the same way the API does: amounts are decimal strings, never JSON numbers. */
export function parseEvmTx(text: string): EvmTransaction {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("The EVM transaction file is not valid JSON."); }
  return parseEvmObject(raw);
}

function describe(summary: DecodedTransactionSummary): string[] {
  return summary.instructions.map((i, n) => {
    const bits = [i.destination ? `to ${i.destination}` : "", i.amount !== undefined ? `amount ${i.amount}${i.asset ? ` (${i.asset})` : ""}` : ""].filter(Boolean);
    return `  ${n + 1}. ${i.programId} :: ${i.instructionName} [${i.mode}]${bits.length ? "  " + bits.join(", ") : ""}`;
  });
}

const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

async function main(): Promise<void> {
  let args;
  try {
    args = parseArgs({
      options: {
        policy: { type: "string" }, tx: { type: "string" }, "tx-file": { type: "string" }, "evm-tx": { type: "string" }, "lookup-tables": { type: "string" },
        spent: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean" }
      },
      allowPositionals: false
    }).values;
  } catch (error) { fail(`${(error as Error).message}\n\n${USAGE}`); }

  if (args.help) { console.log(USAGE); return; }
  if (!args.policy) fail(`--policy is required.\n\n${USAGE}`);
  const inputs = [args.tx, args["tx-file"], args["evm-tx"]].filter((v) => v !== undefined);
  if (inputs.length !== 1) fail(`Give exactly one of --tx, --tx-file or --evm-tx.\n\n${USAGE}`);

  let policy: unknown;
  try { policy = JSON.parse(readFileSync(args.policy, "utf8")); }
  catch (error) { fail(`Policy problem: ${(error as Error).message}`); }

  let spent: Record<string, bigint>;
  try { spent = parseSpent(args.spent); } catch (error) { fail((error as Error).message); }
  const spentToday = Object.fromEntries(Object.entries(spent).map(([asset, amount]) => [asset, amount.toString()]));

  let input: CheckInput;
  try {
    if (args["evm-tx"] !== undefined) {
      input = { chain: "evm", transaction: JSON.parse(readFileSync(args["evm-tx"], "utf8")), policy, spentToday };
    } else {
      const transactionBase64 = (args.tx ?? readFileSync(args["tx-file"]!, "utf8")).trim();
      const lookupTables = args["lookup-tables"] ? JSON.parse(readFileSync(args["lookup-tables"], "utf8")) as Record<string, string[]> : undefined;
      input = { chain: "solana", transactionBase64, policy, spentToday, ...(lookupTables ? { lookupTables } : {}) };
    }
  } catch (error) { fail(`Could not read the input: ${(error as Error).message}`); }

  let result: CheckResult;
  try { result = await runCheck(input); }
  catch (error) {
    if (error instanceof CheckInputError && error.problems.length > 0) fail(`Policy problem: Invalid policy: ${error.problems.join("; ")}`);
    fail(error instanceof CheckInputError && /policy/i.test(error.message) ? `Policy problem: ${error.message}` : `Could not read the transaction: ${(error as Error).message}`);
  }

  if (args.json) {
    console.log(json(result));
  } else {
    console.log(`Decision: ${result.decision}`);
    for (const reason of result.reasons) console.log(`  - ${reason}`);
    console.log("Decoded instructions:");
    for (const line of describe(result.decoded)) console.log(line);
    if (result.policyNotes.length > 0) { console.log("Policy notes:"); for (const note of result.policyNotes) console.log(`  - ${note}`); }
    console.log(`Receipt: input ${result.receipt.inputHash}`);
    console.log(`         result ${result.receipt.resultHash} (${result.receipt.engine.name} ${result.receipt.engine.version})`);
  }
  process.exit(result.decision === "ALLOW" ? 0 : 2);
}

// Run only when executed directly, so the helpers above can be imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
