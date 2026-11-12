import type { DecodedInstructionSummary, DecodedTransactionSummary, Policy, PolicyEvaluation } from "../policy/types.js";
import { evaluatePolicy } from "../policy/evaluate.js";
import { applyChainRule } from "./evaluate.js";
import { normalizeAddress } from "./decode.js";

/** An EIP-712 signature request, in the JSON shape wallets and SDKs use. */
export interface TypedDataRequest {
  /** The address that will sign. */
  from: string;
  typedData: {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}

/** Permit2 is deployed at the same address on every chain it supports. */
export const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const UINT256_MAX = (1n << 256n) - 1n;

type Field = [name: string, type: string];
const fields = (list: Field[]) => list.map(([name, type]) => ({ name, type }));

/** The only layouts the gate understands. A request whose declared types differ is not evaluated as that type. */
const LAYOUTS: Record<string, Record<string, { name: string; type: string }[]>> = {
  Permit: {
    Permit: fields([["owner", "address"], ["spender", "address"], ["value", "uint256"], ["nonce", "uint256"], ["deadline", "uint256"]])
  },
  DaiPermit: {
    Permit: fields([["holder", "address"], ["spender", "address"], ["nonce", "uint256"], ["expiry", "uint256"], ["allowed", "bool"]])
  },
  PermitSingle: {
    PermitSingle: fields([["details", "PermitDetails"], ["spender", "address"], ["sigDeadline", "uint256"]]),
    PermitDetails: fields([["token", "address"], ["amount", "uint160"], ["expiration", "uint48"], ["nonce", "uint48"]])
  },
  PermitBatch: {
    PermitBatch: fields([["details", "PermitDetails[]"], ["spender", "address"], ["sigDeadline", "uint256"]]),
    PermitDetails: fields([["token", "address"], ["amount", "uint160"], ["expiration", "uint48"], ["nonce", "uint48"]])
  },
  PermitTransferFrom: {
    PermitTransferFrom: fields([["permitted", "TokenPermissions"], ["spender", "address"], ["nonce", "uint256"], ["deadline", "uint256"]]),
    TokenPermissions: fields([["token", "address"], ["amount", "uint256"]])
  },
  PermitBatchTransferFrom: {
    PermitBatchTransferFrom: fields([["permitted", "TokenPermissions[]"], ["spender", "address"], ["nonce", "uint256"], ["deadline", "uint256"]]),
    TokenPermissions: fields([["token", "address"], ["amount", "uint256"]])
  }
};

const sameLayout = (declared: TypedDataRequest["typedData"]["types"], expected: Record<string, { name: string; type: string }[]>): boolean =>
  Object.entries(expected).every(([name, list]) => {
    const got = declared[name];
    return Array.isArray(got) && got.length === list.length && got.every((f, i) => f.name === list[i].name && f.type === list[i].type);
  });

/** uint from a decimal string, a 0x hex string or a safe integer number; undefined if it is anything else or out of range. */
function uint(value: unknown, bits: number): bigint | undefined {
  let n: bigint;
  try {
    if (typeof value === "string" && /^(0x[0-9a-fA-F]+|\d+)$/.test(value)) n = BigInt(value);
    else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) n = BigInt(value);
    else return undefined;
  } catch { return undefined; }
  return n >= 0n && n < 1n << BigInt(bits) ? n : undefined;
}

const record = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function flagged(programId: string, name: string, reason: string, accounts: string[] = []): DecodedInstructionSummary {
  return { programId, instructionName: name, fields: { reason }, mode: "raw_dump", accounts };
}

/**
 * Decodes an EIP-712 permit-style signature request into the common summary. A signed permit lets the
 * spender pull funds later with no transaction from the agent, so it is treated like a spend: the spender
 * is the destination and the allowance is the amount, which puts it under the destination allowlist and
 * the per-transaction and daily caps. Anything not recognised exactly (unknown type, layout that differs
 * from the standard one, signer that is not the owner, witness variants whose extra data we cannot read)
 * becomes raw_dump, i.e. review.
 */
export function decodeEvmTypedData(request: TypedDataRequest): DecodedTransactionSummary {
  const signer = normalizeAddress(request.from);
  const feePayer = signer ?? request.from;
  const { domain, types, primaryType, message } = request.typedData;
  const verifying = typeof domain.verifyingContract === "string" ? normalizeAddress(domain.verifyingContract) : undefined;
  const done = (...instructions: DecodedInstructionSummary[]): DecodedTransactionSummary => ({ feePayer, instructions });
  const bad = (reason: string) => done(flagged(verifying ?? "evm:unknown", primaryType, reason, verifying ? [verifying] : []));

  if (signer === undefined) return bad(`Signer "${request.from}" is not a valid address.`);
  if (verifying === undefined) return bad("The signing domain has no valid verifyingContract.");

  // Which standard layout does this claim to be?
  let kind: string | undefined;
  if (primaryType === "Permit") {
    const declared = types.Permit;
    const dai = declared?.some((f) => f.name === "holder");
    kind = dai ? "DaiPermit" : "Permit";
  } else if (primaryType in LAYOUTS) kind = primaryType;
  if (kind === undefined) return bad(`Signature type "${primaryType}" is not one the gate understands, so it cannot say what it authorises.`);
  if (!sameLayout(types, LAYOUTS[kind])) return bad(`The declared field layout of ${primaryType} differs from the standard one; what would be signed cannot be verified.`);

  const spender = typeof message.spender === "string" ? normalizeAddress(message.spender) : undefined;
  if (kind !== "DaiPermit" && spender === undefined) return bad("The spender is missing or not a valid address.");

  const grant = (programId: string, token: string, to: string, amount: bigint): DecodedInstructionSummary => ({
    programId, instructionName: primaryType, fields: { token, spender: to, amount: amount.toString() },
    mode: "interpolated", accounts: [programId, to], destination: to, amount, asset: token
  });

  switch (kind) {
    case "Permit": {
      const owner = typeof message.owner === "string" ? normalizeAddress(message.owner) : undefined;
      const value = uint(message.value, 256);
      if (owner !== signer) return bad("The permit's owner is not the signer.");
      if (value === undefined || uint(message.deadline, 256) === undefined || uint(message.nonce, 256) === undefined) return bad("A numeric field is missing or malformed.");
      return done(grant(verifying, verifying, spender!, value));
    }
    case "DaiPermit": {
      const holder = typeof message.holder === "string" ? normalizeAddress(message.holder) : undefined;
      const dSpender = typeof message.spender === "string" ? normalizeAddress(message.spender) : undefined;
      if (holder !== signer) return bad("The permit's holder is not the signer.");
      if (dSpender === undefined || typeof message.allowed !== "boolean") return bad("The spender or allowed flag is malformed.");
      if (uint(message.expiry, 256) === undefined || uint(message.nonce, 256) === undefined) return bad("A numeric field is missing or malformed.");
      // allowed=true on a DAI-style permit is an unlimited allowance; allowed=false revokes.
      if (!message.allowed) return done({ programId: verifying, instructionName: primaryType, fields: { spender: dSpender, allowed: false }, mode: "interpolated", accounts: [verifying, dSpender] });
      return done(grant(verifying, verifying, dSpender, UINT256_MAX));
    }
    default: {
      // Permit2 forms. Only the real Permit2 contract is understood; a lookalike domain is not.
      if (verifying !== PERMIT2) return bad("This looks like a Permit2 request but the domain is not the Permit2 contract.");
      const single = kind === "PermitSingle" || kind === "PermitTransferFrom";
      const holder = single ? (kind === "PermitSingle" ? record(message.details) : record(message.permitted)) : undefined;
      const entries: Record<string, unknown>[] | undefined = single
        ? (holder ? [holder] : undefined)
        : (Array.isArray(message[kind === "PermitBatch" ? "details" : "permitted"]) ? (message[kind === "PermitBatch" ? "details" : "permitted"] as unknown[]).map((e) => record(e) ?? {}) : undefined);
      if (!entries || entries.length === 0) return bad("The permitted tokens are missing or malformed.");
      const isTransfer = kind === "PermitTransferFrom" || kind === "PermitBatchTransferFrom";
      const deadline = isTransfer ? message.deadline : message.sigDeadline;
      if (uint(deadline, 256) === undefined) return bad("The deadline is missing or malformed.");
      if (isTransfer && uint(message.nonce, 256) === undefined) return bad("The nonce is missing or malformed.");
      const grants: DecodedInstructionSummary[] = [];
      for (const entry of entries) {
        const token = typeof entry.token === "string" ? normalizeAddress(entry.token) : undefined;
        const amount = uint(entry.amount, kind === "PermitSingle" || kind === "PermitBatch" ? 160 : 256);
        if (token === undefined || amount === undefined) return bad("A token or amount is missing or malformed.");
        if (!isTransfer && (uint(entry.expiration, 48) === undefined || uint(entry.nonce, 48) === undefined)) return bad("An expiration or nonce is malformed.");
        grants.push(grant(PERMIT2, token, spender!, amount));
      }
      return done(...grants);
    }
  }
}

export const DEFAULT_PERMIT_LIFETIME_SECONDS = 86_400;
const DEADLINE_KEYS = new Set(["deadline", "sigDeadline", "expiry", "expiration"]);

/** Every expiry-like field in the message (including inside nested structs and arrays), as numbers of seconds. */
function deadlinesOf(value: unknown): bigint[] {
  if (Array.isArray(value)) return value.flatMap(deadlinesOf);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, v]) => {
    if (DEADLINE_KEYS.has(key)) { const n = uint(v, 256); return n === undefined ? [] : [n]; }
    return deadlinesOf(v);
  });
}

/**
 * `nowSeconds` is injectable so tests do not depend on the wall clock. A permit may stay valid for at most
 * policy.maxPermitLifetimeSeconds (default 24 hours) from now; a permit that never expires is the classic
 * way a stolen signature is cashed in later.
 */
export function evaluateEvmTypedData(request: TypedDataRequest, policy: Policy, dailySpentByAsset: Record<string, bigint> = {}, nowSeconds = Math.floor(Date.now() / 1000)): PolicyEvaluation {
  const base = evaluatePolicy(decodeEvmTypedData(request), policy, dailySpentByAsset);
  const limit = BigInt(policy.maxPermitLifetimeSeconds ?? DEFAULT_PERMIT_LIFETIME_SECONDS);
  const latest = deadlinesOf(request.typedData.message).reduce<bigint | undefined>((max, d) => (max === undefined || d > max ? d : max), undefined);
  const evaluation = latest !== undefined && latest - BigInt(nowSeconds) > limit
    ? { ...base, decision: "NEEDS_REVIEW" as const, reasons: [...base.reasons, `The permit stays valid for ${latest - BigInt(nowSeconds)} seconds, longer than the policy's limit of ${limit}.`] }
    : base;
  const raw = request.typedData.domain.chainId;
  const chainId = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
  return applyChainRule(evaluation, policy, chainId);
}
