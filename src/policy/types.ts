/**
 * evaluatePolicy never produces DENY -- an anomaly always routes to a
 * human via NEEDS_REVIEW rather than being silently, autonomously
 * blocked. Only ALLOW and NEEDS_REVIEW are real, reachable outcomes.
 */
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
}

export interface DecodedTransactionSummary {
  instructions: DecodedInstructionSummary[];
  feePayer: string;
}

export interface Policy {
  policyId: string;
  programAllowlist: string[];
  destinationAllowlist: string[];
  maxAmountPerTransaction: Record<string, string>;
  maxAmountPerDay: Record<string, string>;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  reasons: string[];
  decoded: DecodedTransactionSummary;
}
