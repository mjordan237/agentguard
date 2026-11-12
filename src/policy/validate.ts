import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import type { Policy } from "./types.js";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// "evm:native" is the program id the EVM decoder gives plain native transfers.
// EVM addresses are stored lowercase so allowlist matching is case-insensitive; checksum case carries no meaning here.
const address = z.string().refine((value) => {
  if (value === "evm:native" || EVM_ADDRESS.test(value)) return true;
  try { new PublicKey(value); return true; } catch { return false; }
}, "must be a valid base58 Solana address or a 0x EVM address").transform((value) => (EVM_ADDRESS.test(value) ? value.toLowerCase() : value));
const amount = z.string().regex(/^\d+$/, "must be a non-negative integer in base units, as a string");
const bps = z.number().int().min(0).max(10_000);
const mint = z.string().refine((value) => {
  if (value === "native") return true;
  try { new PublicKey(value); return true; } catch { return false; }
}, 'must be a base58 mint address or "native"');
const swapPair = z.object({
  inputMint: mint,
  outputMint: mint,
  minOutPerIn: z.string().regex(/^\d{1,30}(\.\d{1,30})?$/, "must be a non-negative decimal string, for example \"0.0062\"").optional()
}).strict();

/**
 * Shape of a customer-supplied policy. Strict on purpose: an unknown or misspelled field (for example
 * `maxAmountPerTx`) must be rejected, not silently ignored, because an ignored limit is a missing limit.
 * An empty destinationAllowlist fails closed: value-moving instructions go to review unless allowAnyDestination is true.
 */
const policySchema = z.object({
  policyId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "must be 1-64 characters of letters, digits, '.', '_' or '-'"),
  programAllowlist: z.array(address),
  destinationAllowlist: z.array(address),
  allowAnyDestination: z.boolean().optional(),
  allowedChainIds: z.array(z.number().int().positive()).optional(),
  maxPermitLifetimeSeconds: z.number().int().positive().optional(),
  trustedDelegates: z.array(address).optional(),
  maxAmountPerTransaction: z.record(z.string().min(1), amount),
  maxAmountPerDay: z.record(z.string().min(1), amount),
  maxPriorityFeePerTransaction: amount.optional(),
  swapPairs: z.array(swapPair).max(100).optional(),
  maxSlippageBps: bps.optional(),
  maxPlatformFeeBps: bps.optional(),
  maxPositiveSlippageBps: bps.optional()
}).strict();

/** Validates `input` as a policy. Returns the parsed policy, or every problem found, one line each. */
export function checkPolicy(input: unknown): { policy: Policy; problems: [] } | { policy?: undefined; problems: string[] } {
  const result = policySchema.safeParse(input);
  if (result.success) return { policy: result.data, problems: [] };
  return { problems: result.error.issues.map((issue) => `${issue.path.join(".") || "(policy)"}: ${issue.message}`) };
}

/** Throws an Error listing every problem if `input` is not a valid policy. */
export function parsePolicy(input: unknown): Policy {
  const checked = checkPolicy(input);
  if (!checked.policy) throw new Error(`Invalid policy: ${checked.problems.join("; ")}`);
  return checked.policy;
}
