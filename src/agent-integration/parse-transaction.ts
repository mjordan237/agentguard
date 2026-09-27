import { VersionedTransaction, AddressLookupTableAccount, PublicKey } from "@solana/web3.js";
import { IdlRegistry, resolveInstructionName } from "./idl-registry.js";
import { decodeTransaction } from "./decode.js";
import type { DecodedInstructionSummary, DecodedTransactionSummary } from "../policy/types.js";

/**
 * Resolves one Address Lookup Table account, or null if it can't be
 * found/read. In production this is a thin wrapper around
 * `Connection.getAddressLookupTable` (see src/index.ts); tests supply a
 * local resolver so ALT-indexing correctness can be verified without a
 * live RPC round-trip.
 */
export type LookupTableResolver = (address: PublicKey) => Promise<AddressLookupTableAccount | null>;

function unresolvableAltSummary(feePayer: string, reason: string): DecodedTransactionSummary {
  return {
    feePayer,
    instructions: [
      {
        programId: "unresolved-address-lookup-table",
        instructionName: "unknown",
        fields: { reason },
        mode: "raw_dump",
        accounts: []
      }
    ]
  };
}

/**
 * Parses a base64-encoded Solana transaction and runs every instruction
 * through the registry + solana-clear-sign decoder.
 *
 * Resolves Address Lookup Tables when a resolver is supplied. Per the
 * x402 SVM spec's Sponsor Acceptance Policy, an ALT that can't be
 * resolved must be rejected rather than assumed safe -- and the same
 * applies if no resolver was configured at all, since that's just
 * another way of not being able to resolve it.
 */
export async function parseAndDecodeTransaction(
  transactionBase64: string,
  registry: IdlRegistry,
  resolveLookupTable?: LookupTableResolver
): Promise<DecodedTransactionSummary> {
  const transaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, "base64"));
  const message = transaction.message;
  const feePayer = message.staticAccountKeys[0]?.toBase58() ?? "unknown";

  let addressLookupTableAccounts: AddressLookupTableAccount[] = [];
  if (message.addressTableLookups.length > 0) {
    if (!resolveLookupTable) {
      return unresolvableAltSummary(
        feePayer,
        "Transaction uses Address Lookup Tables but no resolver was configured; failing closed rather than decoding an incomplete account list."
      );
    }

    const resolved = await Promise.all(message.addressTableLookups.map((lookup) => resolveLookupTable(lookup.accountKey)));
    const unresolvedIndex = resolved.findIndex((table) => table === null);
    if (unresolvedIndex !== -1) {
      const badAddress = message.addressTableLookups[unresolvedIndex]!.accountKey.toBase58();
      return unresolvableAltSummary(
        feePayer,
        `Address Lookup Table ${badAddress} could not be resolved. Per the x402 SVM Sponsor Acceptance Policy, an unresolved ALT must be rejected, not assumed safe.`
      );
    }

    addressLookupTableAccounts = resolved as AddressLookupTableAccount[];
  }

  // getAccountKeys() is the correct way to index into a message's
  // accounts regardless of whether they came from static keys or a
  // resolved ALT -- indices in compiledInstructions can point into
  // either, and indexing staticAccountKeys directly (as before ALT
  // support existed) would silently return the wrong account for any
  // index beyond the static portion.
  const accountKeys = message.getAccountKeys({ addressLookupTableAccounts });

  const decodableInstructions = message.compiledInstructions.map((compiled) => {
    const programId = accountKeys.get(compiled.programIdIndex)?.toBase58() ?? "unknown";
    const accounts = compiled.accountKeyIndexes.map((index) => accountKeys.get(index)?.toBase58() ?? "unknown");
    return { programId, accounts, instructionData: compiled.data };
  });

  // Decoded in original transaction order, not grouped by outcome --
  // order matters for a human (or a pitch video) reviewing what an
  // agent actually did, instruction by instruction.
  const instructions: DecodedInstructionSummary[] = decodableInstructions.map((instruction) => {
    const registered = registry.lookup(instruction.programId);
    if (!registered) {
      return {
        programId: instruction.programId,
        instructionName: "unknown",
        fields: { reason: "Program is not in the IDL registry; cannot verify or decode." },
        mode: "raw_dump",
        accounts: instruction.accounts
      };
    }

    const instructionName = resolveInstructionName(registered.idl, instruction.instructionData);
    if (!instructionName) {
      return {
        programId: instruction.programId,
        instructionName: "unknown",
        fields: { reason: "No instruction in the registered IDL matches this data's discriminator." },
        mode: "raw_dump",
        accounts: instruction.accounts
      };
    }

    const decoded = decodeTransaction(feePayer, [
      {
        ...instruction,
        instructionName,
        idl: registered.idl,
        provenance: registered.provenance,
        instructionPolicy: registered.instructionPolicy?.[instructionName]
      }
    ]);
    return decoded.instructions[0];
  });

  return { feePayer, instructions };
}
