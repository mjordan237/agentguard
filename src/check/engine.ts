import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { readFileSync } from "node:fs";
import { AddressLookupTableAccount, PublicKey } from "@solana/web3.js";
import { parseAndDecodeTransaction, type LookupTableResolver } from "../agent-integration/parse-transaction.js";
import { registerStandardPrograms } from "../agent-integration/standard-programs.js";
import { buildDemoRegistry } from "../../demo/policy.js";
import { evaluatePolicy } from "../policy/evaluate.js";
import { checkPolicy } from "../policy/validate.js";
import type { DecodedTransactionSummary, Policy, PolicyEvaluation } from "../policy/types.js";
import { decodeEvmTransaction, type EvmTransaction } from "../evm/decode.js";
import { evaluateEvmTransaction } from "../evm/evaluate.js";

/**
 * One check of one transaction against one policy, shared by `npm run check` and the public sandbox API, so the
 * two cannot drift apart. Every result carries a receipt: a hash of the exact input and a hash of the result,
 * over canonical JSON. Anyone can rerun the same input locally and compare the hashes to confirm the hosted API
 * gave the answer the published code gives.
 */

const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { version: string };
export const ENGINE = { name: "agentguard", version: packageJson.version } as const;

export { canonicalJson };

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export type CheckInput =
  | { chain: "solana"; transactionBase64: string; policy: unknown; spentToday?: Record<string, string>; lookupTables?: Record<string, string[]> }
  | { chain: "evm"; transaction: unknown; policy: unknown; spentToday?: Record<string, string> };

export interface CheckResult {
  decision: PolicyEvaluation["decision"];
  reasons: string[];
  decoded: DecodedTransactionSummary;
  spend: Record<string, string>;
  policyNotes: string[];
  /** Lookup tables used to resolve the transaction, so the check can be repeated offline. */
  lookupTables?: Record<string, string[]>;
  receipt: { engine: typeof ENGINE; inputHash: string; resultHash: string };
}

export class CheckInputError extends Error {
  constructor(message: string, public readonly problems: string[] = []) {
    super(message);
    this.name = "CheckInputError";
  }
}

/** Reads an EVM transaction the way the API does: amounts are decimal strings, never JSON numbers. */
export function parseEvmTx(raw: unknown): EvmTransaction {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("The EVM transaction must be a JSON object.");
  const o = raw as Record<string, unknown>;
  if (typeof o.chainId !== "number" || !Number.isSafeInteger(o.chainId) || o.chainId <= 0) throw new Error('"chainId" must be a positive whole number.');
  if (typeof o.from !== "string") throw new Error('"from" must be a 0x address string.');
  const tx: EvmTransaction = { chainId: o.chainId, from: o.from };
  if (o.to !== undefined) { if (typeof o.to !== "string") throw new Error('"to" must be a 0x address string.'); tx.to = o.to; }
  if (o.data !== undefined) { if (typeof o.data !== "string") throw new Error('"data" must be a 0x-hex string.'); tx.data = o.data; }
  if (o.value !== undefined) {
    if (typeof o.value !== "string" || !/^\d+$/.test(o.value)) throw new Error('"value" must be a decimal string such as "1000000000000000000".');
    tx.value = BigInt(o.value);
  }
  return tx;
}

/** Plain-language warnings about policy settings that make every payment wait for a person. */
export function policyNotes(policy: Policy): string[] {
  const notes: string[] = [];
  if (policy.destinationAllowlist.length === 0 && policy.allowAnyDestination !== true) {
    notes.push("destinationAllowlist is empty and allowAnyDestination is not true, so every payment is held for review.");
  }
  if (policy.programAllowlist.length === 0) notes.push("programAllowlist is empty, so every instruction is held for review.");
  if (Object.keys(policy.maxAmountPerTransaction).length === 0) notes.push("maxAmountPerTransaction sets no limit for any asset, so any payment that moves value is held for review.");
  if (Object.keys(policy.maxAmountPerDay).length === 0) notes.push("maxAmountPerDay sets no limit for any asset, so any payment that moves value is held for review.");
  return notes;
}

function parseSpentToday(spent: Record<string, string> | undefined): Record<string, bigint> {
  const result: Record<string, bigint> = {};
  for (const [asset, amount] of Object.entries(spent ?? {})) {
    if (typeof amount !== "string" || !/^\d{1,78}$/.test(amount)) throw new CheckInputError(`spentToday.${asset} must be a whole number as a string.`);
    result[asset] = BigInt(amount);
  }
  return result;
}

const MAX_LOOKUP_TABLES = 8;
const MAX_TABLE_ADDRESSES = 256;

/** A resolver over tables given in the request. A table the request did not supply resolves to nothing, which holds the transaction. */
function inlineResolver(tables: Record<string, string[]>): LookupTableResolver {
  const entries = Object.entries(tables);
  if (entries.length > MAX_LOOKUP_TABLES) throw new CheckInputError(`At most ${MAX_LOOKUP_TABLES} lookup tables may be supplied.`);
  const parsed = new Map<string, PublicKey[]>();
  for (const [key, addresses] of entries) {
    if (!Array.isArray(addresses) || addresses.length > MAX_TABLE_ADDRESSES) throw new CheckInputError(`Lookup table ${key} must be a list of at most ${MAX_TABLE_ADDRESSES} addresses.`);
    try { parsed.set(new PublicKey(key).toBase58(), addresses.map((address) => new PublicKey(address))); }
    catch { throw new CheckInputError(`Lookup table ${key} contains an invalid address.`); }
  }
  return async (key) => {
    const addresses = parsed.get(key.toBase58());
    return addresses ? new AddressLookupTableAccount({ key, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses } }) : null;
  };
}

/**
 * Runs one check. `fetchLookupTable` is only used for tables the input does not supply; whatever it returns is
 * included in the result, so the same check can be repeated offline with exactly those tables.
 */
export async function runCheck(input: CheckInput, fetchLookupTable?: LookupTableResolver): Promise<CheckResult> {
  const checked = checkPolicy(input.policy);
  if (!checked.policy) throw new CheckInputError("The policy is not valid.", checked.problems);
  const policy = checked.policy;
  const spent = parseSpentToday(input.spentToday);

  let decoded: DecodedTransactionSummary;
  let evaluation: PolicyEvaluation;
  let lookupTables: Record<string, string[]> | undefined;
  if (input.chain === "evm") {
    let tx: EvmTransaction;
    try { tx = parseEvmTx(input.transaction); } catch (error) { throw new CheckInputError((error as Error).message); }
    decoded = decodeEvmTransaction(tx);
    evaluation = evaluateEvmTransaction(tx, policy, spent);
  } else {
    if (typeof input.transactionBase64 !== "string" || input.transactionBase64.length === 0) throw new CheckInputError("transactionBase64 must be a base64 string.");
    const supplied = { ...(input.lookupTables ?? {}) };
    const inline = inlineResolver(supplied);
    const used: Record<string, string[]> = {};
    const resolve: LookupTableResolver = async (key) => {
      const table = (await inline(key)) ?? (fetchLookupTable ? await fetchLookupTable(key) : null);
      if (table) used[key.toBase58()] = table.state.addresses.map((address) => address.toBase58());
      return table;
    };
    try {
      decoded = await parseAndDecodeTransaction(input.transactionBase64.trim(), registerStandardPrograms(buildDemoRegistry()), resolve);
    } catch (error) {
      throw new CheckInputError(`The transaction could not be read: ${(error as Error).message}`);
    }
    evaluation = evaluatePolicy(decoded, policy, spent);
    if (Object.keys(used).length > 0) lookupTables = used;
  }

  const spend = Object.fromEntries(Object.entries(evaluation.spend ?? {}).map(([asset, amount]) => [asset, amount.toString()]));
  const result = { decision: evaluation.decision, reasons: evaluation.reasons, decoded, spend };
  // The input is hashed as it was understood (the parsed policy, the tables actually used), not as it was typed,
  // so formatting and key order in a request do not change the receipt. A zero spent amount is the same as none.
  const spentForHash = Object.fromEntries(Object.entries(spent).filter(([, amount]) => amount > 0n));
  const inputHash = sha256(canonicalJson(input.chain === "evm"
    ? { chain: "evm", transaction: input.transaction, policy, spentToday: spentForHash }
    : { chain: "solana", transactionBase64: input.transactionBase64.trim(), policy, spentToday: spentForHash, lookupTables: lookupTables ?? {} }));
  return {
    ...result,
    policyNotes: policyNotes(policy),
    ...(lookupTables ? { lookupTables } : {}),
    receipt: { engine: ENGINE, inputHash, resultHash: sha256(canonicalJson(result)) }
  };
}
