import type { DecodedTransactionSummary, Policy, PolicyEvaluation } from "../policy/types.js";

/** Returns an account's deployed code as 0x-hex ("0x" for none), or undefined if it could not be read. */
/** `fresh` asks for a read that bypasses any cache; used just before a transaction is broadcast. */
export type CodeLookup = (chainId: number, address: string, fresh?: boolean) => Promise<string | undefined>;

/** EIP-7702: an account whose code is 0xef0100 followed by a 20-byte address runs that address's code. */
const DELEGATION = /^0xef0100([0-9a-f]{40})$/;

/**
 * Looks at the code behind each destination. An allowlist says who the customer meant to pay; it cannot see
 * that an address which was a plain account has since been delegated (EIP-7702) to code that forwards or
 * sweeps what it receives. So:
 *  - a delegated account is sent to review, even if allowlisted, unless its delegate is in policy.trustedDelegates;
 *  - a contract that is in neither destinationAllowlist nor programAllowlist is sent to review (this is the
 *    case that matters under allowAnyDestination);
 *  - code that cannot be read is sent to review, never treated as "no code".
 */
export async function codeCheckReasons(summary: DecodedTransactionSummary, policy: Policy, chainId: number | undefined, lookup: CodeLookup, fresh = false): Promise<string[]> {
  const destinations = [...new Set(summary.instructions.flatMap((i) => (i.mode !== "raw_dump" && i.destination ? [i.destination.toLowerCase()] : [])))];
  if (destinations.length === 0) return [];
  if (chainId === undefined) return ["The chain is not known, so the code behind the destinations cannot be checked."];
  const trusted = new Set((policy.trustedDelegates ?? []).map((a) => a.toLowerCase()));
  const known = new Set([...policy.destinationAllowlist, ...policy.programAllowlist].map((a) => a.toLowerCase()));
  const reasons: string[] = [];
  for (const address of destinations) {
    if (!/^0x[0-9a-f]{40}$/.test(address)) continue; // not an EVM address; nothing to look up
    const code = (await lookup(chainId, address, fresh).catch(() => undefined))?.toLowerCase();
    if (code === undefined || !/^0x([0-9a-f]{2})*$/.test(code)) reasons.push(`The code at ${address} could not be read, so it cannot be checked.`);
    else if (code === "0x") continue;
    else {
      const delegate = DELEGATION.exec(code)?.[1];
      if (delegate) {
        if (!trusted.has(`0x${delegate}`)) reasons.push(`${address} is delegated (EIP-7702) to 0x${delegate}, which is not in the policy's trustedDelegates; what it does with funds it receives is not checked.`);
      }
      else if (!known.has(address)) reasons.push(`${address} is a contract that is not in the policy's allowlists.`);
    }
  }
  return reasons;
}

/** Adds the code check to an evaluation. With no lookup configured the evaluation is returned unchanged. */
export async function applyCodeCheck(evaluation: PolicyEvaluation, summary: DecodedTransactionSummary, policy: Policy, chainId: number | undefined, lookup: CodeLookup | undefined): Promise<PolicyEvaluation> {
  if (!lookup) return evaluation;
  const reasons = await codeCheckReasons(summary, policy, chainId, lookup);
  return reasons.length === 0 ? evaluation : { ...evaluation, decision: "NEEDS_REVIEW", reasons: [...evaluation.reasons, ...reasons] };
}

/**
 * A lookup backed by JSON-RPC eth_getCode, one URL per chain id. Results are cached for `ttlMs` (default 30 s)
 * so a burst of requests is one call per address, and every call times out after 5 s. Errors give undefined.
 */
export function rpcCodeLookup(urls: Record<number, string>, options: { ttlMs?: number; fetchImpl?: typeof fetch } = {}): CodeLookup {
  const ttl = options.ttlMs ?? 30_000;
  const doFetch = options.fetchImpl ?? fetch;
  const cache = new Map<string, { at: number; code: string }>();
  return async (chainId, address, fresh) => {
    const url = urls[chainId];
    if (!url) return undefined;
    const key = `${chainId}:${address.toLowerCase()}`;
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < ttl) return hit.code;
    try {
      const response = await doFetch(url, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(5_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] })
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as { result?: unknown };
      if (typeof body.result !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(body.result)) return undefined;
      cache.set(key, { at: Date.now(), code: body.result });
      return body.result;
    } catch { return undefined; }
  };
}
