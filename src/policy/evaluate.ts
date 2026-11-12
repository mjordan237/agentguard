import { COMPUTE_BUDGET_PROGRAM } from "../agent-integration/standard-programs.js";
import type { DecodedInstructionSummary, DecodedTransactionSummary, Policy, PolicyEvaluation } from "./types.js";
import { isSelfPlumbing, judgeSwap } from "./swap-rules.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const isNonceAdvance = (instruction: DecodedInstructionSummary) =>
  instruction.programId === SYSTEM_PROGRAM && instruction.instructionName === "advanceNonceAccount" && instruction.mode !== "raw_dump";

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

  // Nothing to inspect is not the same as nothing to worry about: an empty transaction still costs
  // the fee payer a fee, and "all zero instructions passed" must not read as approval.
  if (decoded.instructions.length === 0) {
    reasons.push("Transaction contains no instructions.");
  } else if (decoded.instructions.every((instruction) => instruction.programId === COMPUTE_BUDGET_PROGRAM || isNonceAdvance(instruction))) {
    // Compute settings alone do nothing, but the fee payer still pays for the transaction. Found by replaying
    // mainnet traffic once ComputeBudget stopped forcing review: such transactions were being ALLOWed.
    // A nonce advance on its own is the same: the relayer pays and nothing the agent asked for happens.
    reasons.push("Transaction contains only compute budget settings or a nonce advance and no other instruction.");
  }

  // The runtime treats a nonce advance as durable only in first place. Anywhere else it just burns the nonce.
  decoded.instructions.forEach((instruction, index) => {
    if (index > 0 && isNonceAdvance(instruction)) {
      reasons.push(`Instruction ${index} advances a durable nonce, which only belongs first in a transaction.`);
    }
  });

  if (decoded.priorityFee !== undefined && decoded.priorityFee > 0n) {
    const limit = policy.maxPriorityFeePerTransaction;
    if (limit === undefined) {
      reasons.push(`Transaction config sets a priority fee of ${decoded.priorityFee} lamports and the policy defines no priority-fee limit.`);
    } else if (decoded.priorityFee > BigInt(limit)) {
      reasons.push(`Priority fee ${decoded.priorityFee} lamports exceeds the limit of ${limit}.`);
    }
  }

  const swapSigners = new Set(decoded.instructions.flatMap((instruction) => (instruction.swap ? [instruction.swap.authority] : [])));

  for (const instruction of decoded.instructions) {
    if (instruction.mode === "raw_dump") {
      // Say why when the decoder knows: a person approving a review needs the actual reason, not just "unverified".
      const why = instruction.fields.reason;
      reasons.push(`Instruction on ${instruction.programId} could not be verified and fell back to raw_dump${typeof why === "string" ? `: ${why}` : "."}`);
    }
    if (!policy.programAllowlist.includes(instruction.programId)) {
      reasons.push(`Program ${instruction.programId} is not in the allowlist.`);
    }

    if (instruction.swap && instruction.mode !== "raw_dump") {
      const judgement = judgeSwap(instruction.swap, policy);
      reasons.push(...judgement.reasons);
      if (judgement.asset !== undefined) {
        transactionTotalByAsset[judgement.asset] = (transactionTotalByAsset[judgement.asset] ?? 0n) + instruction.swap.inAmount;
      }
      continue;
    }
    // Wrapping SOL for the swap's own signer, or closing its account back to itself: value stays with that key.
    if (swapSigners.size > 0 && isSelfPlumbing(instruction, swapSigners)) continue;

    // instruction.amount is only set when the registry explicitly
    // declared this instruction as policy-relevant (an amountArgName
    // was configured for it) -- so its presence, not just a truthy
    // value, is what marks an instruction as something spend/destination
    // policy applies to.
    if (instruction.amount === undefined) {
      // An instruction that names a destination but carries no amount (creating a token account for someone)
      // still gives that account something, so the destination allowlist applies. Fail closed the same way.
      if (instruction.destination !== undefined && instruction.mode !== "raw_dump") {
        if (policy.destinationAllowlist.length === 0) {
          if (policy.allowAnyDestination !== true) {
            reasons.push(`The policy has no destination allowlist and does not set allowAnyDestination, so ${instruction.instructionName} on ${instruction.programId} needs review.`);
          }
        } else if (!policy.destinationAllowlist.includes(instruction.destination)) {
          reasons.push(`Destination ${instruction.destination} is not in the allowlist.`);
        }
      }
      continue;
    }
    const asset = instruction.asset ?? "native";

    if (policy.destinationAllowlist.length === 0) {
      // An empty list is "not configured", not "anything goes": a forgotten allowlist must not open every destination.
      if (policy.allowAnyDestination !== true) {
        reasons.push(`The policy has no destination allowlist and does not set allowAnyDestination, so value moved by ${instruction.programId} needs review.`);
      }
    } else {
      if (!instruction.destination) {
        reasons.push(`Instruction on ${instruction.programId} moves value but its destination could not be resolved.`);
      } else if (!policy.destinationAllowlist.includes(instruction.destination)) {
        reasons.push(`Destination ${instruction.destination} is not in the allowlist.`);
      }
    }

    transactionTotalByAsset[asset] = (transactionTotalByAsset[asset] ?? 0n) + instruction.amount;
  }

  for (const [asset, transactionTotal] of Object.entries(transactionTotalByAsset)) {
    // The cap is per TRANSACTION, so it applies to the total across instructions. Checking each
    // instruction alone lets 60 + 60 slip under a cap of 100.
    const perTxLimit = policy.maxAmountPerTransaction[asset];
    // No configured limit for an asset that moves value is "unknown", not "unlimited": a token the
    // customer never set a cap for must not be spendable without bound.
    if (perTxLimit === undefined) {
      reasons.push(`The policy sets no per-transaction limit for asset ${asset}.`);
    } else if (transactionTotal > BigInt(perTxLimit)) {
      reasons.push(`Amount ${transactionTotal} (${asset}) exceeds the per-transaction limit of ${perTxLimit}.`);
    }

    const dailyLimit = policy.maxAmountPerDay[asset];
    if (dailyLimit === undefined) {
      reasons.push(`The policy sets no daily limit for asset ${asset}.`);
      continue;
    }
    const projectedDailyTotal = (dailySpentByAsset[asset] ?? 0n) + transactionTotal;
    if (projectedDailyTotal > BigInt(dailyLimit)) {
      reasons.push(
        `This transaction would bring today's total ${asset} spend to ${projectedDailyTotal}, exceeding the daily limit of ${dailyLimit}.`
      );
    }
  }

  if (reasons.length > 0) {
    return { decision: "NEEDS_REVIEW", reasons, decoded, spend: transactionTotalByAsset };
  }

  return { decision: "ALLOW", reasons: [], decoded, spend: transactionTotalByAsset };
}
