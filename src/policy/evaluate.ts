import type { DecodedTransactionSummary, Policy, PolicyEvaluation } from "./types.js";

/**
 * Evaluates a decoded transaction against a policy.
 *
 * `dailySpentByAsset` is the amount already spent today per asset, for
 * per-day limit enforcement. It's supplied by the caller rather than
 * tracked in here, so this function stays pure and testable -- the
 * stateful tracking lives in DailySpendTracker, wired in at the server
 * layer (see src/api/server.ts).
 */
export function evaluatePolicy(
  decoded: DecodedTransactionSummary,
  policy: Policy,
  dailySpentByAsset: Record<string, bigint> = {}
): PolicyEvaluation {
  const reasons: string[] = [];
  const transactionTotalByAsset: Record<string, bigint> = {};

  for (const instruction of decoded.instructions) {
    if (instruction.mode === "raw_dump") {
      reasons.push(`Instruction on ${instruction.programId} could not be verified and fell back to raw_dump.`);
    }
    if (!policy.programAllowlist.includes(instruction.programId)) {
      reasons.push(`Program ${instruction.programId} is not in the allowlist.`);
    }

    // instruction.amount is only set when the registry explicitly
    // declared this instruction as policy-relevant (an amountArgName
    // was configured for it) -- so its presence, not just a truthy
    // value, is what marks an instruction as something spend/destination
    // policy applies to.
    if (instruction.amount === undefined) continue;
    const asset = instruction.asset ?? "native";

    if (policy.destinationAllowlist.length > 0) {
      if (!instruction.destination) {
        reasons.push(`Instruction on ${instruction.programId} moves value but its destination could not be resolved.`);
      } else if (!policy.destinationAllowlist.includes(instruction.destination)) {
        reasons.push(`Destination ${instruction.destination} is not in the allowlist.`);
      }
    }

    const perTxLimit = policy.maxAmountPerTransaction[asset];
    if (perTxLimit !== undefined && instruction.amount > BigInt(perTxLimit)) {
      reasons.push(`Amount ${instruction.amount} (${asset}) exceeds the per-transaction limit of ${perTxLimit}.`);
    }

    transactionTotalByAsset[asset] = (transactionTotalByAsset[asset] ?? 0n) + instruction.amount;
  }

  for (const [asset, transactionTotal] of Object.entries(transactionTotalByAsset)) {
    const dailyLimit = policy.maxAmountPerDay[asset];
    if (dailyLimit === undefined) continue;
    const projectedDailyTotal = (dailySpentByAsset[asset] ?? 0n) + transactionTotal;
    if (projectedDailyTotal > BigInt(dailyLimit)) {
      reasons.push(
        `This transaction would bring today's total ${asset} spend to ${projectedDailyTotal}, exceeding the daily limit of ${dailyLimit}.`
      );
    }
  }

  if (reasons.length > 0) {
    return { decision: "NEEDS_REVIEW", reasons, decoded };
  }

  return { decision: "ALLOW", reasons: [], decoded };
}
