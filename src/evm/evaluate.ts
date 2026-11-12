import { evaluatePolicy } from "../policy/evaluate.js";
import type { Policy, PolicyEvaluation } from "../policy/types.js";
import { decodeEvmTransaction, normalizeAddress, type EvmTransaction } from "./decode.js";
import { routerDeadline } from "./uniswap.js";
import { DEFAULT_PERMIT_LIFETIME_SECONDS } from "./typed-data.js";
import type { SignableEvmTransaction } from "./sign.js";

/** Policy asset name for network fees (gas), so per-transaction and daily fee caps use the same maps as value. */
export const EVM_GAS = "evm:gas";

/**
 * Decodes and evaluates an EVM transaction. Same policy object as Solana: programAllowlist holds the
 * contract addresses (plus "evm:native" for plain transfers), destinationAllowlist the recipients and
 * spenders, limits are per asset (token address or "native"). A policy used for EVM must also say which
 * chains it applies to; with no allowedChainIds the answer is review, never "any chain".
 */
export function evaluateEvmTransaction(tx: EvmTransaction, policy: Policy, dailySpentByAsset: Record<string, bigint> = {}, nowSeconds = Math.floor(Date.now() / 1000)): PolicyEvaluation {
  const evaluation = applyChainRule(evaluatePolicy(decodeEvmTransaction(tx), policy, dailySpentByAsset), policy, tx.chainId);
  // A swap whose router deadline is far away can be held and submitted later; cap it like a permit's lifetime.
  const to = tx.to === undefined ? undefined : normalizeAddress(tx.to);
  const deadline = to === undefined || tx.data === undefined ? undefined : routerDeadline(tx.chainId, to, tx.data);
  const limit = BigInt(policy.maxPermitLifetimeSeconds ?? DEFAULT_PERMIT_LIFETIME_SECONDS);
  if (deadline === undefined || deadline - BigInt(nowSeconds) <= limit) return evaluation;
  return { ...evaluation, decision: "NEEDS_REVIEW", reasons: [...evaluation.reasons, `The swap's router deadline is ${deadline - BigInt(nowSeconds)} seconds away, longer than the policy's limit of ${limit}.`] };
}

/** Adds the chain check to an evaluation. A missing chain id (undefined) is refused, never treated as "any chain". */
export function applyChainRule(evaluation: PolicyEvaluation, policy: Policy, chainId: number | undefined): PolicyEvaluation {
  const chains = policy.allowedChainIds;
  const reasons = [...evaluation.reasons];
  if (chains === undefined || chains.length === 0) {
    reasons.push("The policy lists no allowedChainIds, so no EVM chain is permitted.");
  } else if (chainId === undefined) {
    reasons.push("The request does not name a valid chain id.");
  } else if (!chains.includes(chainId)) {
    reasons.push(`Chain ${chainId} is not in the policy's allowedChainIds.`);
  }
  return { ...evaluation, decision: reasons.length > 0 ? "NEEDS_REVIEW" : "ALLOW", reasons };
}

/**
 * Evaluation for a transaction that is about to be signed. On top of the value rules it bounds the worst-case
 * network fee (gasLimit x maxFeePerGas), which the fee payer always pays and which an agent can inflate without
 * moving any value: the cap is policy.maxAmountPerTransaction["evm:gas"] and the daily total is capped by
 * policy.maxAmountPerDay["evm:gas"]. No configured cap means review, never unlimited.
 */
export function evaluateEvmSignable(tx: SignableEvmTransaction, policy: Policy, dailySpentByAsset: Record<string, bigint> = {}, nowSeconds = Math.floor(Date.now() / 1000)): PolicyEvaluation {
  const evaluation = evaluateEvmTransaction(tx, policy, dailySpentByAsset, nowSeconds);
  const cost = tx.gasLimit * tx.maxFeePerGas;
  const reasons = [...evaluation.reasons];
  const perTx = policy.maxAmountPerTransaction[EVM_GAS];
  const daily = policy.maxAmountPerDay[EVM_GAS];
  if (tx.maxPriorityFeePerGas > tx.maxFeePerGas) reasons.push("maxPriorityFeePerGas exceeds maxFeePerGas.");
  if (perTx === undefined) reasons.push(`The policy sets no per-transaction limit for ${EVM_GAS}.`);
  else if (cost > BigInt(perTx)) reasons.push(`Worst-case network fee ${cost} wei exceeds the limit of ${perTx}.`);
  if (daily === undefined) reasons.push(`The policy sets no daily limit for ${EVM_GAS}.`);
  else if ((dailySpentByAsset[EVM_GAS] ?? 0n) + cost > BigInt(daily)) reasons.push(`This transaction would bring today's network fees to ${(dailySpentByAsset[EVM_GAS] ?? 0n) + cost}, exceeding the daily limit of ${daily}.`);
  return { ...evaluation, decision: reasons.length > 0 ? "NEEDS_REVIEW" : "ALLOW", reasons };
}
