import { decodeVerifiedInstruction, type IdlProvenance } from "solana-clear-sign";
import { resolveDestinationAccount, type InstructionPolicyMetadata } from "./idl-registry.js";
import type { DecodedInstructionSummary, DecodedTransactionSummary } from "../policy/types.js";

/**
 * One instruction extracted from a parsed Solana transaction message,
 * ready to be run through solana-clear-sign's authenticated decoder.
 */
export interface RawInstruction {
  programId: string;
  instructionName: string;
  instructionData: Uint8Array;
  accounts: string[];
  idl: unknown;
  provenance: IdlProvenance;
  instructionPolicy?: InstructionPolicyMetadata;
}

/**
 * Runs every instruction in a transaction through solana-clear-sign's
 * decodeVerifiedInstruction, which checks the IDL digest and binds it to
 * the observed program ID before decoding -- so a spoofed or mismatched
 * IDL can't be used to make a malicious instruction render as benign.
 *
 * When the registry declares InstructionPolicyMetadata for the resolved
 * instruction, also resolves the destination account and amount here --
 * from the verified decode result, not from re-parsing raw bytes.
 */
export function decodeTransaction(feePayer: string, instructions: RawInstruction[]): DecodedTransactionSummary {
  const decoded: DecodedInstructionSummary[] = instructions.map((instruction) => {
    const result = decodeVerifiedInstruction(
      instruction.idl,
      instruction.provenance,
      instruction.programId,
      instruction.instructionName,
      instruction.instructionData,
      instruction.accounts
    );

    if (result.mode === "raw_dump") {
      return {
        programId: instruction.programId,
        instructionName: instruction.instructionName,
        fields: { raw: result.raw, error: result.error },
        mode: "raw_dump",
        accounts: instruction.accounts
      };
    }

    const policy = instruction.instructionPolicy;
    const destination = policy?.destinationAccountName
      ? resolveDestinationAccount(instruction.idl, instruction.instructionName, instruction.accounts, policy.destinationAccountName)
      : undefined;
    const rawAmount = policy?.amountArgName ? result.fields[policy.amountArgName] : undefined;
    const amount = typeof rawAmount === "bigint" ? rawAmount : undefined;

    return {
      programId: instruction.programId,
      instructionName: result.instruction,
      fields: result.fields,
      mode: result.mode,
      accounts: instruction.accounts,
      destination,
      amount,
      asset: amount !== undefined ? (policy?.asset ?? "native") : undefined
    };
  });

  return { feePayer, instructions: decoded };
}
