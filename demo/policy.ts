import { SystemProgram } from "@solana/web3.js";
import { idlSha256 } from "solana-clear-sign";
import { IdlRegistry } from "../src/agent-integration/idl-registry.js";
import type { Policy } from "../src/policy/types.js";

// From solana-clear-sign's own examples/system-transfer.idl.json.
// Only "transfer" is registered -- deliberately. The demo's adversarial
// scenario relies on this: an injected Assign instruction has no entry
// here, so it can't be named or decoded, and falls to raw_dump.
export const systemProgramIdl = {
  version: "0.1.0",
  name: "system_program",
  instructions: [
    {
      name: "transfer",
      discriminator: [2, 0, 0, 0],
      accounts: [{ name: "from" }, { name: "to" }],
      args: [
        {
          name: "lamports",
          type: "u64",
          display: { label: "Amount", formatter: { kind: "amount", isNative: true } }
        }
      ],
      display: { mode: "interpolated", template: "Transfer {lamports} to {to}" }
    }
  ]
};

export function buildDemoRegistry(): IdlRegistry {
  const registry = new IdlRegistry();
  registry.register(SystemProgram.programId.toBase58(), {
    idl: systemProgramIdl,
    provenance: {
      source: "embedded",
      expectedSha256: idlSha256(systemProgramIdl),
      expectedProgramId: SystemProgram.programId.toBase58()
    },
    // Declares that "transfer"'s "to" account is the policy-relevant
    // destination and "lamports" is the policy-relevant amount, in the
    // "native" (SOL) asset -- see InstructionPolicyMetadata for why this
    // is declared here rather than inferred from the IDL's field names.
    instructionPolicy: {
      transfer: { destinationAccountName: "to", amountArgName: "lamports", asset: "native" }
    }
  });
  return registry;
}

/**
 * @param approvedVendors destinations the policy allows payments to
 * @param maxLamportsPerPayment per-transaction spend cap in lamports, as a string
 * @param maxLamportsPerDay daily spend cap in lamports, as a string
 */
export function buildDemoPolicy(
  approvedVendors: string[] = [],
  maxLamportsPerPayment = "1000000000", // 1 SOL
  maxLamportsPerDay = "5000000000" // 5 SOL
): Policy {
  return {
    policyId: "property-maintenance-vendor-payments",
    programAllowlist: [SystemProgram.programId.toBase58()],
    destinationAllowlist: approvedVendors,
    maxAmountPerTransaction: { native: maxLamportsPerPayment },
    maxAmountPerDay: { native: maxLamportsPerDay }
  };
}
