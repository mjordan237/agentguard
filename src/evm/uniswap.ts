import type { DecodedInstructionSummary } from "../policy/types.js";
import { offsetWords, rawDump, uintAt, wordAddress, wordUint, wordsAt, WORD } from "./abi.js";

/**
 * Uniswap SwapRouter02, by chain. A call is only read as a swap when it is sent to the router this table
 * names for the chain; the same selectors sent anywhere else are unknown functions. Only chains where the
 * router and WETH9 have been checked against a node are listed.
 */
export const SWAP_ROUTERS: Record<number, { router: string; weth: string }> = {
  1: { router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45", weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" }
};

const SEL = {
  exactInputSingle: "04e45aaf",
  exactInput: "b858183f",
  exactOutputSingle: "5023b4df",
  exactOutput: "09b81346",
  unwrapWETH9: "49404b7c",
  unwrapWETH9Self: "49616997",
  refundETH: "12210e8a",
  multicallDeadline: "5ae401dc",
  multicall: "ac9650d8",
  multicallBlockhash: "1f0464d1"
} as const;

/** SwapRouter02's magic recipients: 0x1 means the caller, 0x2 means the router itself (tokens left there are not safe). */
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const MAX_INNER_CALLS = 8;

export interface RouterContext {
  chainId: number;
  /** The transaction sender, lowercase. */
  sender: string;
  /** The router the transaction is sent to, lowercase. */
  router: string;
  weth: string;
}

export function routerFor(chainId: number, to: string): { router: string; weth: string } | undefined {
  const known = SWAP_ROUTERS[chainId];
  return known && known.router === to ? known : undefined;
}

type Recipient = { kind: "address"; address: string } | { kind: "router" };

function resolveRecipient(word: string, ctx: RouterContext): Recipient | undefined {
  const a = wordAddress(word);
  if (a === undefined || a === "0x0000000000000000000000000000000000000000") return undefined;
  if (a === MSG_SENDER) return { kind: "address", address: ctx.sender };
  if (a === ADDRESS_THIS) return { kind: "router" };
  return { kind: "address", address: a };
}

interface Swap {
  name: string;
  tokenIn: string;
  tokenOut: string;
  /** Worst case the swap can take from the sender: amountIn, or amountInMaximum for exact-output swaps. */
  spend: bigint;
  minOut: bigint;
  recipient: Recipient;
}

/** Reads a path of token(20) fee(3) token(20) ... Returns first and last token. */
function pathEnds(hexPath: string): { first: string; last: string } | undefined {
  // 40 hex chars per address, 6 per fee; at least one hop.
  if (hexPath.length < 40 + 6 + 40 || (hexPath.length - 40) % 46 !== 0) return undefined;
  return { first: `0x${hexPath.slice(0, 40)}`, last: `0x${hexPath.slice(hexPath.length - 40)}` };
}

function decodeSwap(selector: string, body: string, ctx: RouterContext): Swap | string {
  const bad = "The swap arguments are malformed.";
  if (selector === SEL.exactInputSingle || selector === SEL.exactOutputSingle) {
    // One static tuple of seven words, inline.
    if (body.length !== 7 * WORD) return bad;
    const w = wordsAt(body, 0, 7)!;
    const tokenIn = wordAddress(w[0]), tokenOut = wordAddress(w[1]);
    const fee = wordUint(w[2], 24), recipient = resolveRecipient(w[3], ctx);
    const a = wordUint(w[4], 256), b = wordUint(w[5], 256), limit = wordUint(w[6], 160);
    if (!tokenIn || !tokenOut || fee === undefined || !recipient || a === undefined || b === undefined || limit === undefined) return bad;
    const exactIn = selector === SEL.exactInputSingle;
    return { name: exactIn ? "exactInputSingle" : "exactOutputSingle", tokenIn, tokenOut, spend: exactIn ? a : b, minOut: exactIn ? b : a, recipient };
  }
  // exactInput / exactOutput take a dynamic tuple (bytes path, address recipient, uint256, uint256).
  const tupleWord = offsetWords(uintAt(body, 0, 32));
  const t = tupleWord === undefined ? undefined : wordsAt(body, tupleWord, 4);
  if (tupleWord === undefined || !t) return bad;
  const pathStart = offsetWords(wordUint(t[0], 32));
  if (pathStart === undefined) return bad;
  const lenAt = tupleWord + pathStart;
  const pathLength = uintAt(body, lenAt, 32);
  if (pathLength === undefined) return bad;
  const pathHexStart = (lenAt + 1) * WORD;
  const pathHex = body.slice(pathHexStart, pathHexStart + Number(pathLength) * 2);
  if (pathHex.length !== Number(pathLength) * 2) return bad;
  const ends = pathEnds(pathHex);
  const recipient = resolveRecipient(t[1], ctx);
  const a = wordUint(t[2], 256), b = wordUint(t[3], 256);
  if (!ends || !recipient || a === undefined || b === undefined) return bad;
  return selector === SEL.exactInput
    ? { name: "exactInput", tokenIn: ends.first, tokenOut: ends.last, spend: a, minOut: b, recipient }
    // exactOutput paths run from the output token back to the input token.
    : { name: "exactOutput", tokenIn: ends.last, tokenOut: ends.first, spend: b, minOut: a, recipient };
}

const SWAP_SELECTORS = new Set<string>([SEL.exactInputSingle, SEL.exactInput, SEL.exactOutputSingle, SEL.exactOutput]);

/** Splits a multicall's `bytes[]` argument into hex calldata strings, reading it the way Solidity does. */
function bytesArray(body: string, arrayArgIndex: number): string[] | undefined {
  const base = offsetWords(uintAt(body, arrayArgIndex, 32));
  if (base === undefined) return undefined;
  const n = uintAt(body, base, 32);
  if (n === undefined || n > BigInt(MAX_INNER_CALLS)) return undefined;
  const offsets = wordsAt(body, base + 1, Number(n));
  if (!offsets) return undefined;
  const out: string[] = [];
  for (const o of offsets) {
    const rel = offsetWords(wordUint(o, 32));
    if (rel === undefined) return undefined;
    const itemAt = base + 1 + rel;
    const length = uintAt(body, itemAt, 32);
    if (length === undefined) return undefined;
    const start = (itemAt + 1) * WORD;
    const data = body.slice(start, start + Number(length) * 2);
    if (data.length !== Number(length) * 2) return undefined;
    out.push(data);
  }
  return out;
}

/** One non-swap router call we understand. */
type Sweep = { name: string; recipient: Recipient };

function decodeUnwrap(selector: string, body: string, ctx: RouterContext): Sweep | string {
  if (selector === SEL.unwrapWETH9Self) {
    return body.length === WORD && wordUint(body, 256) !== undefined
      ? { name: "unwrapWETH9", recipient: { kind: "address", address: ctx.sender } } : "unwrapWETH9 arguments are malformed.";
  }
  if (body.length !== 2 * WORD) return "unwrapWETH9 arguments are malformed.";
  const w = wordsAt(body, 0, 2)!;
  // Unlike the swap functions, unwrapWETH9 sends ETH to the address it is given, literally: 0x..01 and 0x..02 are
  // NOT "the caller" and "the router" here (measured on a mainnet fork: ETH sent to 0x..01 is gone).
  const to = wordAddress(w[1]);
  if (wordUint(w[0], 256) === undefined || to === undefined || to === "0x0000000000000000000000000000000000000000") return "unwrapWETH9 arguments are malformed.";
  return { name: "unwrapWETH9", recipient: { kind: "address", address: to } };
}

const recipientAddress = (r: Recipient, ctx: RouterContext) => (r.kind === "address" ? r.address : ctx.router);

function swapInstruction(swap: Swap, destination: string, ctx: RouterContext): DecodedInstructionSummary {
  return {
    programId: ctx.router, instructionName: swap.name, mode: "interpolated", accounts: [ctx.router, destination],
    fields: { tokenIn: swap.tokenIn, tokenOut: swap.tokenOut, spend: swap.spend.toString(), minimumOut: swap.minOut.toString(), recipient: destination },
    destination, amount: swap.spend, asset: swap.tokenIn
  };
}

/**
 * Decodes a call to SwapRouter02. Mapping to the common summary: the swap's input token is the asset, its
 * worst-case input is the amount, and the account that ends up with the output is the destination. A swap to
 * the sender is given the router as its destination (list the router in destinationAllowlist), so swapping to
 * yourself passes and swapping to anyone else is checked against the allowlist.
 *
 * Review (raw_dump) instead of guessing: a zero minimum output (no protection against a sandwich), tokens
 * left in the router (anyone can sweep them), native value attached, nested multicalls, more than 8 inner
 * calls, any inner call that is not a swap/unwrap/refund, and anything malformed.
 */
export function decodeSwapRouterCall(selector: string, body: string, value: bigint, ctx: RouterContext): DecodedInstructionSummary[] {
  const flag = (name: string, reason: string) => [rawDump(ctx.router, name, reason, [ctx.router])];
  const isMulticall = selector === SEL.multicall || selector === SEL.multicallDeadline || selector === SEL.multicallBlockhash;

  if (value !== 0n) return flag(isMulticall ? "multicall" : "swap", "Native value is attached to a router call; swaps paid in ETH are not supported.");

  if (!isMulticall) {
    if (SWAP_SELECTORS.has(selector)) {
      const swap = decodeSwap(selector, body, ctx);
      if (typeof swap === "string") return flag(selector, swap);
      if (swap.minOut === 0n) return flag(swap.name, "The swap accepts any output (minimum output is zero), so it can be sandwiched for nearly all of its value.");
      if (swap.recipient.kind === "router") return flag(swap.name, "The swap leaves its output in the router, where anyone can sweep it.");
      const destination = swap.recipient.address === ctx.sender ? ctx.router : swap.recipient.address;
      return [swapInstruction(swap, destination, ctx)];
    }
    return flag(`selector-0x${selector}`, `Router function 0x${selector} is not one the gate understands.`);
  }

  const array = selector === SEL.multicall ? 0 : 1;
  if (selector === SEL.multicallDeadline && uintAt(body, 0, 256) === undefined) return flag("multicall", "The deadline is malformed.");
  if (selector === SEL.multicallBlockhash && !wordsAt(body, 0, 1)) return flag("multicall", "The previous-blockhash argument is missing.");
  const calls = bytesArray(body, array);
  if (!calls) return flag("multicall", `The call list is malformed or has more than ${MAX_INNER_CALLS} calls.`);
  if (calls.length === 0) return flag("multicall", "The multicall is empty.");

  const swaps: Swap[] = [];
  const sweeps: Sweep[] = [];
  for (const call of calls) {
    const sel = call.slice(0, 8);
    const inner = call.slice(8);
    if (SWAP_SELECTORS.has(sel)) {
      const swap = decodeSwap(sel, inner, ctx);
      if (typeof swap === "string") return flag("multicall", swap);
      swaps.push(swap);
    } else if (sel === SEL.unwrapWETH9 || sel === SEL.unwrapWETH9Self) {
      const sweep = decodeUnwrap(sel, inner, ctx);
      if (typeof sweep === "string") return flag("multicall", sweep);
      sweeps.push(sweep);
    } else if (sel === SEL.refundETH && inner.length === 0) {
      // Returns the router's ETH balance to the sender: no new risk.
    } else {
      return flag("multicall", `A call inside the multicall (0x${sel}) is not a swap, unwrap or refund; nested and other calls are not supported.`);
    }
  }
  if (swaps.length === 0) return flag("multicall", "The multicall contains no swap.");

  // A swap that pays the router is only safe when the same multicall unwraps WETH to a known recipient straight after.
  const toRouter = swaps.filter((s) => s.recipient.kind === "router");
  let sweepDestination: string | undefined;
  if (toRouter.length > 0) {
    if (sweeps.length !== 1 || sweeps[0].recipient.kind === "router") return flag("multicall", "A swap leaves its output in the router and the multicall does not unwrap it to a single recipient.");
    if (toRouter.some((s) => s.tokenOut !== ctx.weth)) return flag("multicall", "A swap leaves a token other than WETH in the router, where anyone can sweep it.");
    sweepDestination = recipientAddress(sweeps[0].recipient, ctx);
  }

  const out: DecodedInstructionSummary[] = [];
  for (const swap of swaps) {
    if (swap.minOut === 0n) return flag(swap.name, "The swap accepts any output (minimum output is zero), so it can be sandwiched for nearly all of its value.");
    const raw = swap.recipient.kind === "router" ? sweepDestination! : swap.recipient.address;
    out.push(swapInstruction(swap, raw === ctx.sender ? ctx.router : raw, ctx));
  }
  // An unwrap that sends ETH elsewhere moves value out of the sender's swap proceeds: check where it goes.
  for (const sweep of sweeps) {
    const to = recipientAddress(sweep.recipient, ctx);
    if (to !== ctx.router && to !== ctx.sender) {
      out.push({ programId: ctx.router, instructionName: "unwrapWETH9", fields: { recipient: to }, mode: "interpolated", accounts: [ctx.router, to], destination: to, amount: 0n, asset: "native" });
    }
  }
  return out;
}

/**
 * The deadline argument of a SwapRouter02 `multicall(uint256,bytes[])` call, or undefined for any other call.
 * The router rejects the transaction after this time; a far-future deadline lets a signed transaction be held
 * and submitted later, so the evaluator caps it. Calls without a deadline argument are not capped here.
 */
export function routerDeadline(chainId: number, to: string, data: string): bigint | undefined {
  if (!routerFor(chainId, to)) return undefined;
  const hex = data.toLowerCase();
  if (!hex.startsWith(`0x${SEL.multicallDeadline}`)) return undefined;
  return uintAt(hex.slice(2 + 8), 0, 256);
}
