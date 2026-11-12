import type { DecodedInstructionSummary } from "./types.js";

/**
 * What one decoded instruction does, for people reading it. The policy engine does not use this: it treats
 * destination + amount as value at risk, so an EVM approval carries the spender as destination and the allowance
 * as amount (see src/evm/decode.ts). That is right for caps and wrong for a label, so this table says which
 * decoder outputs are approvals, swaps or wraps rather than payments. It is keyed on what the decoders emit
 * (src/evm/decode.ts, src/evm/typed-data.ts, src/evm/uniswap.ts, the Solana IDL registry and Jupiter decoder);
 * test/transaction-summary.test.ts runs those decoders so a rename here or there is caught.
 */
export type OperationKind =
  | "transfer" | "approval" | "allowance_revoke" | "nft_operator_approval" | "nft_operator_revoke"
  | "swap" | "wrap" | "unwrap" | "other" | "undecoded";

export interface Operation {
  kind: OperationKind;
  instructionName: string;
  programId: string;
  /** Asset spent, approved or moved: a token address or mint, or "native". */
  asset?: string;
  amount?: bigint;
  /** Recipient of a transfer, spender of an approval, operator of an NFT approval, recipient of a swap. */
  counterparty?: string;
  /** The approval has no practical limit (the type's maximum value). */
  unlimited?: boolean;
  /** Given by signing a message (a permit), not by a transaction. */
  bySignature?: boolean;
  /** For a swap: what comes out, and the least of it accepted. */
  assetOut?: string;
  minimumOut?: bigint;
}

const MAX_UINT256 = (1n << 256n) - 1n;
/** Permit2 allowances are uint160; its maximum is how Permit2 spells "unlimited". */
const MAX_UINT160 = (1n << 160n) - 1n;

const EVM_TOKEN_TRANSFERS = new Set(["transfer", "transferFrom"]);
const EVM_ALLOWANCES = new Set(["approve", "increaseAllowance"]);
/** EIP-2612 / DAI permits and Permit2 forms; typed-data.ts names the instruction after the primary type. */
const PERMITS = new Set(["Permit", "PermitSingle", "PermitBatch", "PermitTransferFrom", "PermitBatchTransferFrom"]);
/** SwapRouter02 calls uniswap.ts decodes, each with the input token as asset and its worst-case spend as amount. */
const EVM_SWAPS = new Set(["exactInputSingle", "exactInput", "exactOutputSingle", "exactOutput"]);

const isEvm = (programId: string) => programId.startsWith("evm:") || /^0x[0-9a-fA-F]{40}$/.test(programId);
const bigintField = (value: unknown): bigint | undefined => {
  if (typeof value === "bigint") return value;
  return typeof value === "string" && /^\d{1,80}$/.test(value) ? BigInt(value) : undefined;
};
const stringField = (value: unknown) => (typeof value === "string" ? value : undefined);

export function classifyInstruction(i: DecodedInstructionSummary): Operation {
  const base = { instructionName: i.instructionName, programId: i.programId };
  if (isEvm(i.programId)) {
    if (i.mode === "raw_dump") {
      // The one blanket grant the decoder recognises but never decodes as routine: it records the operator for us.
      if (i.instructionName === "setApprovalForAll" && i.fields.approved === true && stringField(i.fields.operator)) {
        return { ...base, kind: "nft_operator_approval", counterparty: stringField(i.fields.operator), asset: i.programId };
      }
      return { ...base, kind: "undecoded" };
    }
    if (i.instructionName === "transfer" && i.programId === "evm:native") return { ...base, kind: "transfer", asset: "native", amount: i.amount, counterparty: i.destination };
    if (EVM_TOKEN_TRANSFERS.has(i.instructionName) && i.destination && i.amount !== undefined) return { ...base, kind: "transfer", asset: i.asset, amount: i.amount, counterparty: i.destination };
    if (EVM_ALLOWANCES.has(i.instructionName) && i.destination && i.amount !== undefined) {
      if (i.instructionName === "approve" && i.amount === 0n) return { ...base, kind: "allowance_revoke", asset: i.asset, counterparty: i.destination };
      return { ...base, kind: "approval", asset: i.asset, amount: i.amount, counterparty: i.destination, unlimited: i.amount === MAX_UINT256 };
    }
    if (PERMITS.has(i.instructionName)) {
      const spender = i.destination ?? stringField(i.fields.spender);
      if (i.fields.allowed === false) return { ...base, kind: "allowance_revoke", asset: i.programId, counterparty: spender, bySignature: true };
      if (i.amount !== undefined) {
        return { ...base, kind: "approval", asset: i.asset, amount: i.amount, counterparty: spender, bySignature: true, unlimited: i.amount === MAX_UINT256 || i.amount === MAX_UINT160 };
      }
      return { ...base, kind: "undecoded" };
    }
    if (i.instructionName === "setApprovalForAll" && i.fields.approved === false) return { ...base, kind: "nft_operator_revoke", counterparty: stringField(i.fields.operator), asset: i.programId };
    if (i.instructionName === "deposit") return { ...base, kind: "wrap", asset: "native", amount: i.amount };
    if (i.instructionName === "withdraw") return { ...base, kind: "unwrap", asset: i.programId, amount: bigintField(i.fields.amount) };
    if (EVM_SWAPS.has(i.instructionName)) {
      return { ...base, kind: "swap", asset: i.asset, amount: i.amount, counterparty: i.destination, assetOut: stringField(i.fields.tokenOut), minimumOut: bigintField(i.fields.minimumOut) };
    }
    if (i.instructionName === "unwrapWETH9") return { ...base, kind: "unwrap", asset: "wrapped native", counterparty: i.destination };
    return { ...base, kind: "other" };
  }
  // Solana.
  if (i.mode === "raw_dump") return { ...base, kind: "undecoded" };
  if (i.swap) return { ...base, kind: "swap", asset: i.swap.sourceMint, amount: i.swap.inAmount, counterparty: i.swap.destinationTokenAccount, assetOut: i.swap.destinationMint };
  // The IDL registry sets destination and amount only from an instruction's declared value-transfer metadata.
  if (i.destination && i.amount !== undefined) return { ...base, kind: "transfer", asset: i.asset ?? "native", amount: i.amount, counterparty: i.destination };
  return { ...base, kind: "other" };
}
