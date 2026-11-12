import { idlSha256 } from "solana-clear-sign";
import type { IdlRegistry } from "./idl-registry.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/**
 * SPL Token / Token-2022 `TransferChecked`, the only token transfer we verify. It names the mint, so the
 * asset is known from the transaction itself and a token amount is checked against that mint's limit.
 * Plain `Transfer` (no mint) is deliberately NOT registered: its asset cannot be known without an RPC
 * lookup, so it falls to raw_dump and goes to review rather than being guessed. A transfer with extra
 * accounts (a multisig authority, Token-2022 transfer-hook accounts) fails the decoder's account-count
 * check and also goes to review.
 */
export const splTokenIdl = {
  version: "0.1.0",
  name: "spl_token",
  instructions: [
    {
      name: "transferChecked",
      discriminator: [12],
      accounts: [{ name: "source" }, { name: "mint" }, { name: "destination" }, { name: "authority" }],
      args: [{ name: "amount", type: "u64" }, { name: "decimals", type: "u8" }],
      display: { mode: "interpolated", template: "Transfer {amount} base units of token {mint} ({decimals} decimals) to token account {destination}" }
    },
    // Wrapping and unwrapping SOL around a swap. closeAccount sends the account's lamports to `destination`,
    // so that account is the policy destination; with a multisig owner it has extra accounts and goes to review.
    {
      name: "closeAccount",
      discriminator: [9],
      accounts: [{ name: "account" }, { name: "destination" }, { name: "owner" }],
      args: [],
      display: { mode: "interpolated", template: "Close token account {account}, sending its lamports to {destination}" }
    },
    {
      name: "syncNative",
      discriminator: [17],
      accounts: [{ name: "account" }],
      args: [],
      display: { mode: "interpolated", template: "Sync wrapped SOL balance of {account}" }
    }
  ]
};

/**
 * ComputeBudget instructions carry no value, but every real transaction has them, and without a decode each
 * one lands in raw_dump and sends an otherwise clean payment to review. The priority fee they imply is
 * checked separately, from the raw data, in parse-transaction.ts.
 */
export const computeBudgetIdl = {
  version: "0.1.0",
  name: "compute_budget",
  instructions: [
    { name: "requestHeapFrame", discriminator: [1], accounts: [], args: [{ name: "bytes", type: "u32" }], display: { mode: "interpolated", template: "Request a heap of {bytes} bytes" } },
    { name: "setComputeUnitLimit", discriminator: [2], accounts: [], args: [{ name: "units", type: "u32" }], display: { mode: "interpolated", template: "Set compute unit limit to {units}" } },
    { name: "setComputeUnitPrice", discriminator: [3], accounts: [], args: [{ name: "microLamports", type: "u64" }], display: { mode: "interpolated", template: "Set compute unit price to {microLamports} micro-lamports" } },
    { name: "setLoadedAccountsDataSizeLimit", discriminator: [4], accounts: [], args: [{ name: "bytes", type: "u32" }], display: { mode: "interpolated", template: "Limit loaded account data to {bytes} bytes" } }
  ]
};

const provenance = (programId: string, idl: unknown) => ({ source: "embedded" as const, expectedSha256: idlSha256(idl), expectedProgramId: programId });

/** Adds SPL Token, Token-2022 and ComputeBudget to a registry. Programs still need to be in a customer's policy allowlist to be ALLOWed. */
export function registerStandardPrograms(registry: IdlRegistry): IdlRegistry {
  for (const programId of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    registry.register(programId, {
      idl: splTokenIdl,
      provenance: provenance(programId, splTokenIdl),
      instructionPolicy: {
        transferChecked: { destinationAccountName: "destination", amountArgName: "amount", assetAccountName: "mint" },
        closeAccount: { destinationAccountName: "destination" }
      }
    });
  }
  registry.register(COMPUTE_BUDGET_PROGRAM, { idl: computeBudgetIdl, provenance: provenance(COMPUTE_BUDGET_PROGRAM, computeBudgetIdl) });
  return registry;
}
