import { PublicKey } from "@solana/web3.js";
import type { DecodedInstructionSummary, Policy, SwapSummary } from "./types.js";

export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Wrapped SOL is SOL: it shares the "native" limits, so swapping SOL cannot sidestep the SOL caps. */
export const assetKey = (mint: string) => (mint === WRAPPED_SOL_MINT || mint === "native" ? "native" : mint);

export function associatedTokenAccount(owner: string, tokenProgram: string, mint: string): string | undefined {
  try {
    return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()], new PublicKey(ASSOCIATED_TOKEN_PROGRAM))[0].toBase58();
  } catch {
    return undefined;
  }
}

const isOwnAta = (account: string, owner: string, mint: string, programs: (string | undefined)[]) =>
  programs.some((program) => program !== undefined && associatedTokenAccount(owner, program, mint) === account);

const BOTH_PROGRAMS = [TOKEN_PROGRAM, TOKEN_2022_PROGRAM];

/** Decimal string to a fraction, exactly: "0.0062" is 62/10000. */
function fraction(decimal: string): [bigint, bigint] {
  const [whole, part = ""] = decimal.split(".");
  return [BigInt(whole + part), 10n ** BigInt(part.length)];
}

export interface SwapJudgement {
  reasons: string[];
  /** Limit key the input counts against, when the source mint could be established. */
  asset?: string;
}

/** Applies a policy's swap rules to one decoded swap. Every failure is a reason, so the swap goes to review. */
export function judgeSwap(swap: SwapSummary, policy: Policy): SwapJudgement {
  const reasons: string[] = [];
  const pairs = policy.swapPairs ?? [];
  if (pairs.length === 0) return { reasons: ["The policy lists no swap pairs, so no swap is allowed without review."] };

  // Legacy `route` names no source mint. Find which allowed input mint the source account belongs to.
  let sourceMint = swap.sourceMint;
  if (sourceMint === undefined) {
    const candidates = [...new Set(pairs.map((pair) => (pair.inputMint === "native" ? WRAPPED_SOL_MINT : pair.inputMint)))];
    sourceMint = candidates.find((mint) => isOwnAta(swap.sourceTokenAccount, swap.authority, mint, [swap.tokenProgram, ...BOTH_PROGRAMS]));
    if (sourceMint === undefined) {
      return { reasons: [`The swap's source account ${swap.sourceTokenAccount} is not the signer's own token account for any input mint the policy allows.`] };
    }
  } else if (!isOwnAta(swap.sourceTokenAccount, swap.authority, sourceMint, [swap.sourceTokenProgram, swap.tokenProgram])) {
    reasons.push(`The swap's source account ${swap.sourceTokenAccount} is not the signer's own token account for mint ${sourceMint}.`);
  }

  const pair = pairs.find((candidate) => assetKey(candidate.inputMint) === assetKey(sourceMint!) && assetKey(candidate.outputMint) === assetKey(swap.destinationMint));
  if (!pair) reasons.push(`Swapping ${sourceMint} for ${swap.destinationMint} is not a pair the policy allows.`);

  const toSelf = isOwnAta(swap.destinationTokenAccount, swap.authority, swap.destinationMint, [swap.destinationTokenProgram, swap.tokenProgram, ...BOTH_PROGRAMS]);
  if (!toSelf && !policy.destinationAllowlist.includes(swap.destinationTokenAccount)) {
    reasons.push(`The swap's output goes to ${swap.destinationTokenAccount}, which is neither the signer's own token account nor in the destination allowlist.`);
  }

  if (swap.quotedOutAmount === 0n) reasons.push("The swap's quoted output is zero, so it accepts any price.");
  if (policy.maxSlippageBps === undefined) reasons.push("The policy sets no maxSlippageBps.");
  else if (swap.slippageBps > policy.maxSlippageBps) reasons.push(`Slippage tolerance ${swap.slippageBps} bps exceeds the policy's ${policy.maxSlippageBps} bps.`);

  if (pair?.minOutPerIn !== undefined && swap.slippageBps <= 10_000) {
    // Guaranteed minimum output, rounded down as the program rounds it.
    const minimumOut = (swap.quotedOutAmount * BigInt(10_000 - swap.slippageBps)) / 10_000n;
    const [numerator, denominator] = fraction(pair.minOutPerIn);
    if (minimumOut * denominator < swap.inAmount * numerator) {
      reasons.push(`The swap guarantees at least ${minimumOut} out for ${swap.inAmount} in, below the policy's floor of ${pair.minOutPerIn} per unit.`);
    }
  }

  if (swap.platformFeeBps > 0) {
    if (policy.maxPlatformFeeBps === undefined || swap.platformFeeBps > policy.maxPlatformFeeBps) {
      reasons.push(`The swap takes a platform fee of ${swap.platformFeeBps} bps, above the policy's ${policy.maxPlatformFeeBps ?? 0} bps.`);
    } else if (swap.platformFeeAccount === undefined) {
      reasons.push(`The swap takes a platform fee of ${swap.platformFeeBps} bps but names no fee account, so where the fee goes cannot be checked.`);
    } else if (!policy.destinationAllowlist.includes(swap.platformFeeAccount)) {
      reasons.push(`The swap's platform fee goes to ${swap.platformFeeAccount}, which is not in the destination allowlist.`);
    }
  }
  if (swap.positiveSlippageBps > (policy.maxPositiveSlippageBps ?? 0)) {
    reasons.push(`The swap keeps ${swap.positiveSlippageBps} bps of any output above the quote, above the policy's ${policy.maxPositiveSlippageBps ?? 0} bps.`);
  }

  return { reasons, asset: assetKey(sourceMint) };
}

/**
 * True for the plumbing around a swap that only moves value between accounts of the swap's own signer:
 * wrapping SOL into its wrapped-SOL account, closing its token account back to itself, creating its own token
 * account at its own expense. These neither count against limits nor need an allowlisted destination. The
 * sender and the owner must be the same key: an account merely named by some swap is not enough.
 */
export function isSelfPlumbing(instruction: DecodedInstructionSummary, signers: Set<string>): boolean {
  if (instruction.mode === "raw_dump" || instruction.destination === undefined) return false;
  const [first, second, third] = instruction.accounts;
  if (instruction.programId === SYSTEM_PROGRAM && instruction.instructionName === "transfer") {
    return first !== undefined && signers.has(first) && isOwnAta(instruction.destination, first, WRAPPED_SOL_MINT, BOTH_PROGRAMS);
  }
  if ((instruction.programId === TOKEN_PROGRAM || instruction.programId === TOKEN_2022_PROGRAM) && instruction.instructionName === "closeAccount") {
    return third !== undefined && signers.has(third) && second === third;
  }
  if (instruction.programId === ASSOCIATED_TOKEN_PROGRAM && (instruction.instructionName === "create" || instruction.instructionName === "createIdempotent")) {
    const owner = instruction.fields.owner;
    return typeof owner === "string" && signers.has(owner) && first === owner;
  }
  return false;
}
