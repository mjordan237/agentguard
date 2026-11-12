/** evaluatePolicy never produces DENY -- an anomaly routes to a human via NEEDS_REVIEW instead of being autonomously blocked. */
export type PolicyDecision = "ALLOW" | "NEEDS_REVIEW";

export interface DecodedInstructionSummary {
  programId: string;
  instructionName: string;
  fields: Record<string, unknown>;
  mode: "interpolated" | "fallback" | "raw_dump";
  accounts: string[];
  /** Resolved via the registry's InstructionPolicyMetadata, not guessed from field names. */
  destination?: string;
  amount?: bigint;
  asset?: string;
  /** Set only for a decoded swap. Swaps are judged by their own rules in evaluatePolicy, not the transfer rules. */
  swap?: SwapSummary;
}

/** An exact-in Jupiter v6 swap, read from the instruction itself. */
export interface SwapSummary {
  router: "jupiter-v6";
  /** route, shared_accounts_route, route_v2 or shared_accounts_route_v2. */
  variant: string;
  /** The account that signs for the input tokens: the agent. */
  authority: string;
  sourceTokenAccount: string;
  /** Absent for legacy `route`, which names no source mint; evaluatePolicy derives it from the policy's swap pairs. */
  sourceMint?: string;
  /** Token programs that own the source and destination accounts, when the instruction names them. */
  sourceTokenProgram?: string;
  destinationTokenProgram?: string;
  /** Legacy `route` names one token program for both sides. */
  tokenProgram?: string;
  /** Where the output actually lands. */
  destinationTokenAccount: string;
  destinationMint: string;
  inAmount: bigint;
  quotedOutAmount: bigint;
  slippageBps: number;
  platformFeeBps: number;
  /** Legacy instructions name the fee account; v2 does not. */
  platformFeeAccount?: string;
  positiveSlippageBps: number;
  steps: number;
}

/** A pair of mints a policy lets the agent swap, input to output. "native" means SOL (wrapped SOL is treated the same). */
export interface SwapPair {
  inputMint: string;
  outputMint: string;
  /**
   * Worst acceptable price, as output base units per input base unit, a decimal string (for example "0.0062").
   * The swap's guaranteed minimum output (quote minus slippage) must be at least inAmount times this. Without
   * it, Jupiter enforces only the agent's own quote, which a compromised agent can set as low as it likes.
   */
  minOutPerIn?: string;
}

export interface DecodedTransactionSummary {
  instructions: DecodedInstructionSummary[];
  feePayer: string;
  /** Wire format of the transaction message. */
  messageVersion?: "legacy" | 0 | 1;
  /**
   * Priority fee in lamports declared in a version-1 message's own config, paid by the fee payer on
   * top of the base fee (measured on mainnet: charged fee = 5000 x signatures + this value).
   * Version 1 moves this out of ComputeBudget instructions, so instruction checks alone never see it.
   */
  priorityFee?: bigint;
}

export interface Policy {
  policyId: string;
  programAllowlist: string[];
  destinationAllowlist: string[];
  /**
   * An empty destinationAllowlist does NOT mean "any destination". Set this to true to say so on purpose;
   * otherwise any instruction that moves value goes to review.
   */
  allowAnyDestination?: boolean;
  /** EVM only: chain ids this policy applies to. Absent or empty means no EVM chain is permitted. */
  allowedChainIds?: number[];
  /**
   * EVM only: how far in the future a signed permit may stay valid, in seconds. Longer ones go to review.
   * Absent means 86400 (24 hours): a permit that never expires is the classic way a stolen signature is used later.
   */
  maxPermitLifetimeSeconds?: number;
  /**
   * EVM only: implementation addresses a destination may be delegated to (EIP-7702) without review, for example
   * a smart-wallet contract the customer trusts. A destination delegated to anything else still goes to review.
   */
  trustedDelegates?: string[];
  maxAmountPerTransaction: Record<string, string>;
  maxAmountPerDay: Record<string, string>;
  /**
   * Cap, in lamports, on the priority fee a version-1 transaction may declare in its config. When
   * unset, any non-zero priority fee sends the transaction to review rather than being ignored.
   */
  maxPriorityFeePerTransaction?: string;
  /** Solana swaps: the only mint pairs the agent may swap. Absent or empty means any swap goes to review. */
  swapPairs?: SwapPair[];
  /** Solana swaps: the largest slippage tolerance, in basis points. Absent means any swap goes to review. */
  maxSlippageBps?: number;
  /** Solana swaps: the largest platform fee, in basis points. Absent means a swap with any platform fee goes to review. */
  maxPlatformFeeBps?: number;
  /** Solana swaps (v2 routes): the largest share of output above the quote that may be taken as a fee. Absent means 0. */
  maxPositiveSlippageBps?: number;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reasons: string[];
  decoded: DecodedTransactionSummary;
  /** What the limits were checked against, per asset: the amounts the daily budget records. */
  spend?: Record<string, bigint>;
  /** For a swap checked by simulation: the net change per asset across the swap signer's accounts. */
  simulation?: { netChange: Record<string, string> };
}
