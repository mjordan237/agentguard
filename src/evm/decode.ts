import type { DecodedInstructionSummary, DecodedTransactionSummary } from "../policy/types.js";
import { normalizeAddress, rawDump, words, wordAddress } from "./abi.js";
import { decodeSwapRouterCall, routerFor, SWAP_ROUTERS } from "./uniswap.js";

const wrappedNative = (chainId: number): string | undefined => SWAP_ROUTERS[chainId]?.weth;

export { normalizeAddress };

/** An unsigned EVM transaction as an agent would submit it. Addresses are 0x + 40 hex; `data` is 0x-hex. */
export interface EvmTransaction {
  chainId: number;
  from: string;
  /** Absent for contract creation, which is never allowed through. */
  to?: string;
  value?: bigint;
  data?: string;
}

/** Policy asset name for the chain's native coin, same as Solana. */
export const EVM_NATIVE = "native";

const SELECTORS = {
  transfer: "a9059cbb",
  approve: "095ea7b3",
  increaseAllowance: "39509351",
  transferFrom: "23b872dd",
  setApprovalForAll: "a22cb465",
  deposit: "d0e30db0",
  withdraw: "2e1a7d4d"
} as const;

/**
 * Decodes one EVM transaction into the same summary the Solana path produces, so evaluatePolicy and the
 * daily-spend tracker apply unchanged. Mapping: contract address -> programId, recipient or spender ->
 * destination, token address (or "native") -> asset. Approvals are given an amount on purpose, so the
 * per-transaction and daily caps and the destination allowlist apply to them: an unlimited approval
 * exceeds any sensible cap and goes to review.
 *
 * Anything this decoder cannot verify (unknown selector, malformed words, contract creation, calls that
 * move funds from a third party) becomes raw_dump, which evaluatePolicy sends to review.
 */
export function decodeEvmTransaction(tx: EvmTransaction): DecodedTransactionSummary {
  const from = normalizeAddress(tx.from);
  const feePayer = from ?? tx.from;
  const to = tx.to === undefined ? undefined : normalizeAddress(tx.to);
  const value = tx.value ?? 0n;
  const hex = (tx.data ?? "0x").toLowerCase();
  const done = (instruction: DecodedInstructionSummary): DecodedTransactionSummary => ({ feePayer, instructions: [instruction] });

  if (from === undefined) return done(rawDump("evm:unknown", "invalid-from", `Sender "${tx.from}" is not a valid address.`, []));
  if (tx.to === undefined) return done(rawDump("evm:create", "contract-creation", "Contract creation is never allowed through the gate.", []));
  if (to === undefined) return done(rawDump("evm:unknown", "invalid-to", `Recipient "${tx.to}" is not a valid address.`, []));
  if (value < 0n) return done(rawDump(to, "invalid-value", "Negative value.", [to]));
  if (!/^0x([0-9a-f]{2})*$/.test(hex)) return done(rawDump(to, "invalid-data", "Calldata is not valid hex.", [to]));

  const data = hex.slice(2);

  // Plain native transfer.
  if (data.length === 0) {
    return done({
      programId: "evm:native", instructionName: "transfer", fields: { to, value: value.toString() }, mode: "interpolated",
      accounts: [to], destination: to, amount: value, asset: EVM_NATIVE
    });
  }

  const selector = data.slice(0, 8);
  const body = data.slice(8);

  // ERC-20 and similar calls move tokens, not native value. Native value attached to them is unexplained.
  const tokenCall = (name: string, destinationWord: string, amountWord: string): DecodedTransactionSummary => {
    const destination = wordAddress(destinationWord);
    if (destination === undefined) return done(rawDump(to, name, "Address argument is malformed.", [to]));
    if (value !== 0n) return done(rawDump(to, name, "Native value is attached to a token call; its purpose is unknown.", [to]));
    return done({
      programId: to, instructionName: name, fields: { destination, amount: BigInt(`0x${amountWord}`).toString() },
      mode: "interpolated", accounts: [to, destination], destination, amount: BigInt(`0x${amountWord}`), asset: to
    });
  };

  switch (selector) {
    case SELECTORS.transfer: {
      const w = words(body, 2);
      return w ? tokenCall("transfer", w[0], w[1]) : done(rawDump(to, "transfer", "Calldata does not match transfer(address,uint256).", [to]));
    }
    case SELECTORS.approve:
    case SELECTORS.increaseAllowance: {
      const name = selector === SELECTORS.approve ? "approve" : "increaseAllowance";
      const w = words(body, 2);
      return w ? tokenCall(name, w[0], w[1]) : done(rawDump(to, name, `Calldata does not match ${name}(address,uint256).`, [to]));
    }
    case SELECTORS.transferFrom: {
      const w = words(body, 3);
      if (!w) return done(rawDump(to, "transferFrom", "Calldata does not match transferFrom(address,address,uint256).", [to]));
      const source = wordAddress(w[0]);
      if (source === undefined) return done(rawDump(to, "transferFrom", "Address argument is malformed.", [to]));
      if (source !== from) {
        return done(rawDump(to, "transferFrom", `Moves tokens from ${source}, not from the sender; the allowance behind it is not verified.`, [to, source]));
      }
      return tokenCall("transferFrom", w[1], w[2]);
    }
    case SELECTORS.setApprovalForAll: {
      const w = words(body, 2);
      if (!w) return done(rawDump(to, "setApprovalForAll", "Calldata does not match setApprovalForAll(address,bool).", [to]));
      const operator = wordAddress(w[0]);
      if (operator === undefined || !/^0{63}[01]$/.test(w[1])) return done(rawDump(to, "setApprovalForAll", "Arguments are malformed.", [to]));
      // Granting an operator control of every token of a collection has no amount to cap, so it always needs a person.
      // Still raw_dump, so it always goes to review; operator and approved are kept so a reviewer is told what it grants.
      if (w[1].endsWith("1")) {
        const grant = rawDump(to, "setApprovalForAll", `Grants ${operator} control of every token in the collection.`, [to, operator]);
        return done({ ...grant, fields: { ...grant.fields, operator, approved: true } });
      }
      return done({ programId: to, instructionName: "setApprovalForAll", fields: { operator, approved: false }, mode: "interpolated", accounts: [to, operator] });
    }
    case SELECTORS.deposit: {
      // WETH's deposit(): wraps the attached native value. On any other contract the same name can do anything.
      if (to !== wrappedNative(tx.chainId)) return done(rawDump(to, "deposit", `deposit() is only understood on this chain's WETH contract, not ${to}.`, [to]));
      if (body.length !== 0) return done(rawDump(to, "deposit", "Calldata does not match deposit().", [to]));
      return done({ programId: to, instructionName: "deposit", fields: { value: value.toString() }, mode: "interpolated", accounts: [to], destination: to, amount: value, asset: EVM_NATIVE });
    }
    case SELECTORS.withdraw: {
      // WETH's withdraw: unwraps the sender's tokens into the sender's own balance. A vault or pool with the same
      // signature may send funds elsewhere, so only the known WETH contract is read this way.
      if (to !== wrappedNative(tx.chainId)) return done(rawDump(to, "withdraw", `withdraw(uint256) is only understood on this chain's WETH contract, not ${to}.`, [to]));
      const w = words(body, 1);
      if (!w) return done(rawDump(to, "withdraw", "Calldata does not match withdraw(uint256).", [to]));
      if (value !== 0n) return done(rawDump(to, "withdraw", "Native value is attached to withdraw; its purpose is unknown.", [to]));
      return done({ programId: to, instructionName: "withdraw", fields: { amount: BigInt(`0x${w[0]}`).toString() }, mode: "interpolated", accounts: [to] });
    }
    default: {
      const known = routerFor(tx.chainId, to);
      if (known) {
        return { feePayer, instructions: decodeSwapRouterCall(selector, body, value, { chainId: tx.chainId, sender: from, router: known.router, weth: known.weth }) };
      }
      return done(rawDump(to, `selector-0x${selector}`, `Unknown function 0x${selector}; the gate does not guess what it does.`, [to]));
    }
  }
}
