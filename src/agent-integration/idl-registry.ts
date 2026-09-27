import type { IdlProvenance } from "solana-clear-sign";

/**
 * Declares, for one instruction, which account is the policy-relevant
 * destination and which decoded arg is the policy-relevant amount.
 *
 * This is deliberately declared by us (the firewall operator curating
 * which programs are trusted) rather than inferred from IDL account/arg
 * names by convention -- guessing "the account named 'to' is the
 * destination" across arbitrary third-party IDLs is exactly the kind of
 * unverified assumption this project exists to avoid.
 */
export interface InstructionPolicyMetadata {
  destinationAccountName?: string;
  amountArgName?: string;
  /** Key into Policy.maxAmountPerTransaction / maxAmountPerDay. Defaults to "native" (SOL). */
  asset?: string;
}

export interface RegisteredProgram {
  idl: unknown;
  provenance: IdlProvenance;
  instructionPolicy?: Record<string, InstructionPolicyMetadata>;
}

/**
 * Resolves the destination account's pubkey for an instruction, using
 * the position of the named account in the IDL's declared accounts list
 * for that instruction (accounts are positional, both in the IDL and in
 * the runtime instruction's account list).
 */
export function resolveDestinationAccount(
  idl: unknown,
  instructionName: string,
  accounts: string[],
  destinationAccountName: string
): string | undefined {
  const instructions = (idl as { instructions?: Array<{ name: string; accounts?: Array<{ name: string }> }> })?.instructions;
  const instruction = instructions?.find((entry) => entry.name === instructionName);
  const index = instruction?.accounts?.findIndex((account) => account.name === destinationAccountName);
  if (index === undefined || index < 0) return undefined;
  return accounts[index];
}

/**
 * Maps a program ID to its trusted IDL and provenance record. An agent
 * transaction touching a program that isn't registered here cannot be
 * verified -- decodeVerifiedInstruction needs a known expectedSha256 and
 * expectedProgramId to bind against, so unregistered programs must be
 * treated as unverifiable by the caller, not passed to the decoder.
 */
export class IdlRegistry {
  private readonly programs = new Map<string, RegisteredProgram>();

  register(programId: string, entry: RegisteredProgram): void {
    this.programs.set(programId, entry);
  }

  lookup(programId: string): RegisteredProgram | undefined {
    return this.programs.get(programId);
  }
}

/**
 * Finds the instruction definition in an IDL whose discriminator matches
 * the leading bytes of raw instruction data. Returns undefined if no
 * instruction in the IDL declares a matching discriminator -- decode
 * cannot proceed without knowing which instruction this is.
 */
export function resolveInstructionName(idl: unknown, instructionData: Uint8Array): string | undefined {
  const instructions = (idl as { instructions?: Array<{ name: string; discriminator?: number[] }> })?.instructions;
  if (!Array.isArray(instructions)) return undefined;

  for (const instruction of instructions) {
    const discriminator = instruction.discriminator;
    if (!discriminator || discriminator.length === 0) continue;
    if (discriminator.length > instructionData.length) continue;
    const matches = discriminator.every((byte, index) => instructionData[index] === byte);
    if (matches) return instruction.name;
  }

  return undefined;
}
