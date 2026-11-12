import { VersionedTransaction, AddressLookupTableAccount, PublicKey } from "@solana/web3.js";
import { IdlRegistry, resolveInstructionName } from "./idl-registry.js";
import { decodeTransaction } from "./decode.js";
import { decodePaymentExtras } from "./payment-extras.js";
import { decodeJupiter } from "./jupiter.js";
import type { DecodedInstructionSummary, DecodedTransactionSummary } from "../policy/types.js";

/**
 * Resolves one Address Lookup Table account, or null if it can't be
 * found/read. In production this is a thin wrapper around
 * `Connection.getAddressLookupTable` (see src/index.ts); tests supply a
 * local resolver so ALT-indexing correctness can be verified without a
 * live RPC round-trip.
 */
export type LookupTableResolver = (address: PublicKey) => Promise<AddressLookupTableAccount | null>;

/** Wraps a resolver so a slow RPC answers "not found" (which holds the transaction) instead of hanging the request. */
export function withLookupTimeout(resolver: LookupTableResolver, timeoutMs = 5_000): LookupTableResolver {
  return (address) => new Promise((resolve) => {
    const timer = setTimeout(() => { console.error(`Address lookup table ${address.toBase58()} was not read within ${timeoutMs} ms.`); resolve(null); }, timeoutMs);
    resolver(address).then((table) => resolve(table), () => resolve(null)).finally(() => clearTimeout(timer));
  });
}

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
    const extra = decodeJupiter(instruction.programId, instruction.accounts, instruction.instructionData)
      ?? decodePaymentExtras(instruction.programId, instruction.accounts, instruction.instructionData);
    if (extra) return extra;

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

  const version = transaction.version;
  const computeFee = version === 1 ? undefined : priorityFeeFromComputeBudget(decodableInstructions);
  const messageVersion: "legacy" | 0 | 1 = version === 0 || version === 1 ? version : "legacy";
  // A version-1 message declares compute settings and the priority fee in its own config, not in
  // ComputeBudget instructions, so read it here or it would never reach the policy.
  const config = (message as { transactionConfig?: { priorityFee?: bigint | number | null } }).transactionConfig;
  if (messageVersion === 1 && config === undefined) {
    return unresolvableAltSummary(feePayer, "Version-1 message has no readable transaction config; failing closed rather than ignoring its priority fee.");
  }
  const priorityFee = messageVersion === 1 ? BigInt(config?.priorityFee ?? 0) : computeFee;

  return { feePayer, instructions, messageVersion, priorityFee };
}

const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;
const DEFAULT_UNITS_PER_BUILTIN_INSTRUCTION = 3_000n;
const MAX_UNITS = 1_400_000n;

/**
 * Native (built-in) programs. When a transaction sets no compute unit limit the runtime reserves a small
 * 3,000 units for each instruction that targets one of these, and 200,000 for every other instruction.
 * Verified against the fee charged on real mainnet transactions (scripts/verify-priority-fee.mjs): treating
 * System as a 200,000-unit instruction overstated the fee, and so did leaving out ComputeBudget's own 3,000.
 */
const BUILTIN_PROGRAMS = new Set([
  "11111111111111111111111111111111",
  COMPUTE_BUDGET_PROGRAM,
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "Config1111111111111111111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "AddressLookupTab1e1111111111111111111111111"
]);

/**
 * Priority fee in lamports that a legacy or v0 transaction pays on top of the base fee, from its
 * ComputeBudget instructions: ceil(compute unit limit x price in micro-lamports / 1,000,000). With no
 * explicit limit the limit is the runtime default described above, capped at 1.4M. Read from the raw
 * instruction data, independently of the IDL registry, so it is checked even when ComputeBudget is not
 * registered. Returns undefined when no price is set.
 */
function priorityFeeFromComputeBudget(instructions: Array<{ programId: string; instructionData: Uint8Array }>): bigint | undefined {
  let price: bigint | undefined;
  let limit: bigint | undefined;
  for (const instruction of instructions) {
    if (instruction.programId !== COMPUTE_BUDGET_PROGRAM) continue;
    const data = Buffer.from(instruction.instructionData);
    // The runtime reads these with a deserializer that ignores trailing bytes (seen on mainnet: a limit
    // instruction padded to 9 bytes), so require a minimum length, not an exact one. An exact check would
    // let a padded instruction hide a large limit and make the fee look smaller than it is.
    if (data[0] === 3 && data.length >= 9) price = data.readBigUInt64LE(1);
    if (data[0] === 2 && data.length >= 5) limit = BigInt(data.readUInt32LE(1));
  }
  if (price === undefined || price === 0n) return undefined;
  let defaultUnits = 0n;
  for (const instruction of instructions) {
    defaultUnits += BUILTIN_PROGRAMS.has(instruction.programId) ? DEFAULT_UNITS_PER_BUILTIN_INSTRUCTION : DEFAULT_UNITS_PER_INSTRUCTION;
  }
  const units = limit ?? (defaultUnits > MAX_UNITS ? MAX_UNITS : defaultUnits);
  return (units * price + 999_999n) / 1_000_000n;
}
