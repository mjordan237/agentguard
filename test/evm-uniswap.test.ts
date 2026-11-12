import test from "node:test";
import assert from "node:assert/strict";
import { decodeEvmTransaction } from "../src/evm/decode.js";
import { evaluateEvmTransaction } from "../src/evm/evaluate.js";
import { SWAP_ROUTERS, routerDeadline } from "../src/evm/uniswap.js";
import { parsePolicy } from "../src/policy/validate.js";
import { V } from "./evm-uniswap-vectors.js";

const ROUTER = SWAP_ROUTERS[1].router;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = SWAP_ROUTERS[1].weth;
const agent = "0x1111111111111111111111111111111111111111";
const attacker = "0x3333333333333333333333333333333333333333";

const policyWith = (perTx: string, daily = "100000000000") => parsePolicy({
  policyId: "swap", programAllowlist: [ROUTER, USDC], destinationAllowlist: [ROUTER],
  maxAmountPerTransaction: { [USDC]: perTx }, maxAmountPerDay: { [USDC]: daily }, allowedChainIds: [1]
});
const tight = policyWith("2000000000"); // 2000 USDC per swap
const loose = policyWith("5000000000");
const swapTx = (data: string, over: object = {}) => ({ chainId: 1, from: agent, to: ROUTER, data, ...over });
// The vectors' multicall deadline is 1893456000; the tests' clock sits ten minutes before it.
const NOW = 1_893_456_000 - 600;
const verdict = (data: string, p = tight, over: object = {}) => evaluateEvmTransaction(swapTx(data, over), p, {}, NOW);

test("uniswap: exactInputSingle to the sender is read correctly and allowed within caps", () => {
  const d = decodeEvmTransaction(swapTx(V.eis_self)).instructions;
  assert.equal(d.length, 1);
  assert.equal(d[0].instructionName, "exactInputSingle");
  assert.equal(d[0].asset, USDC);
  assert.equal(d[0].amount, 1_000_000_000n);
  assert.equal(d[0].fields.tokenOut, WETH);
  assert.equal(d[0].fields.minimumOut, "1");
  assert.equal(d[0].destination, ROUTER, "a swap to yourself maps to the router, which the policy lists");
  assert.equal(verdict(V.eis_self).decision, "ALLOW");
});

test("uniswap: output to anyone else, a zero minimum and tokens left in the router all go to review", () => {
  assert.equal(verdict(V.eis_atk).decision, "NEEDS_REVIEW");
  assert.match(JSON.stringify(verdict(V.eis_atk).reasons), new RegExp(attacker));
  assert.match(JSON.stringify(verdict(V.eis_zero_min).reasons), /minimum output is zero/);
  assert.match(JSON.stringify(verdict(V.eis_router).reasons), /anyone can sweep/);
});

test("uniswap: multi-hop paths are read from their ends, and exact-output swaps count their worst-case input", () => {
  const ei = decodeEvmTransaction(swapTx(V.ei_self)).instructions[0];
  assert.equal(ei.fields.tokenIn, USDC);
  assert.equal(ei.fields.tokenOut, WETH);
  assert.equal(ei.amount, 1_000_000_000n);
  const eos = decodeEvmTransaction(swapTx(V.eos_self)).instructions[0];
  assert.equal(eos.amount, 3_000_000_000n, "amountInMaximum, not the exact output");
  assert.equal(eos.asset, USDC);
  const eo = decodeEvmTransaction(swapTx(V.eo_self)).instructions[0];
  assert.equal(eo.amount, 3_000_000_000n);
  assert.equal(eo.fields.tokenIn, USDC, "an exact-output path runs output-first, so the input token is last");
  assert.equal(eo.fields.tokenOut, WETH);
  assert.equal(verdict(V.eos_self, tight).decision, "NEEDS_REVIEW", "3000 USDC worst case exceeds the 2000 cap");
  assert.equal(verdict(V.eos_self, loose).decision, "ALLOW");
  assert.equal(verdict(V.eo_self, loose).decision, "ALLOW");
});

test("uniswap: multicall with swap-to-router then unwrap to the sender is allowed", () => {
  const d = decodeEvmTransaction(swapTx(V.mc_swap_unwrap_self)).instructions;
  assert.equal(d.length, 1);
  assert.equal(d[0].destination, ROUTER, "the output ends up with the sender");
  assert.equal(verdict(V.mc_swap_unwrap_self).decision, "ALLOW");
  assert.equal(verdict(V.mc_swap_refund).decision, "ALLOW");
  assert.equal(verdict(V.mc_blockhash).decision, "ALLOW");
});

test("uniswap: multicall that unwraps to an attacker, leaves funds in the router, or contains anything else goes to review", () => {
  assert.equal(verdict(V.mc_swap_unwrap_atk).decision, "NEEDS_REVIEW");
  assert.match(JSON.stringify(verdict(V.mc_swap_unwrap_atk).reasons), new RegExp(attacker));
  assert.match(JSON.stringify(verdict(V.mc_swap_no_unwrap).reasons), /does not unwrap/);
  assert.match(JSON.stringify(verdict(V.mc_unknown).reasons), /not a swap, unwrap or refund/);
  assert.match(JSON.stringify(verdict(V.mc_nested).reasons), /not a swap, unwrap or refund/);
});

test("uniswap: native value, another chain, and the same selector sent to some other contract are not read as swaps", () => {
  assert.match(JSON.stringify(verdict(V.eis_self, tight, { value: 1n }).reasons), /Native value is attached/);
  assert.equal(verdict(V.eis_self, tight, { chainId: 137 }).decision, "NEEDS_REVIEW");
  const elsewhere = parsePolicy({ ...tight, programAllowlist: [USDC, attacker] });
  const r = evaluateEvmTransaction(swapTx(V.eis_self, { to: attacker }), elsewhere);
  assert.equal(r.decision, "NEEDS_REVIEW");
  assert.match(JSON.stringify(r.reasons), /Unknown function/);
});

test("uniswap: the daily cap counts swaps", () => {
  const p = policyWith("2000000000", "1500000000");
  assert.equal(evaluateEvmTransaction(swapTx(V.eis_self), p, { [USDC]: 500_000_000n }).decision, "ALLOW");
  assert.equal(evaluateEvmTransaction(swapTx(V.eis_self), p, { [USDC]: 500_000_001n }).decision, "NEEDS_REVIEW");
});

test("uniswap: truncated or corrupted router calldata never throws and never passes", () => {
  for (const [name, data] of Object.entries(V)) {
    const body = data.slice(2);
    // Cut 1..6 whole words from the end.
    // (A cut shorter than a word can fall in the zero padding after the last item, which Solidity's decoder accepts too.)
    for (const cut of [64, 128, 192, 256, 320, 384]) {
      if (body.length - cut <= 8) continue;
      const short = `0x${body.slice(0, body.length - cut)}`;
      assert.doesNotThrow(() => decodeEvmTransaction(swapTx(short)), `${name} cut ${cut}`);
      const decision = verdict(short).decision;
      // Only multicall(bytes32,...) etc. could still parse if the cut falls in padding; any survivor must at least be the same swap.
      if (decision === "ALLOW") assert.fail(`${name} truncated by ${cut} hex chars was allowed`);
    }
    // Overwrite each word in turn with garbage: it must not throw.
    const words = Math.floor((body.length - 8) / 64);
    for (let i = 0; i < words; i++) {
      for (const junk of ["f".repeat(64), "0".repeat(64), "00000000000000000000000100000000000000000000000000000000000000ff"]) {
        const at = 8 + i * 64;
        const mutated = `0x${body.slice(0, at)}${junk}${body.slice(at + 64)}`;
        assert.doesNotThrow(() => decodeEvmTransaction(swapTx(mutated)), `${name} word ${i}`);
      }
    }
  }
});

test("uniswap: dirty high bits in an address or uint24 word are malformed, not truncated", () => {
  const body = V.eis_self.slice(2);
  const set = (word: number, value: string) => `0x${body.slice(0, 8 + word * 64)}${value}${body.slice(8 + (word + 1) * 64)}`;
  assert.match(JSON.stringify(verdict(set(0, "ff" + "0".repeat(22) + USDC.slice(2))).reasons), /malformed/);
  assert.match(JSON.stringify(verdict(set(2, "0".repeat(55) + "ffffffff1")).reasons), /malformed/);
  assert.match(JSON.stringify(verdict(set(3, "0".repeat(64))).reasons), /malformed/, "recipient zero");
});

test("uniswap: only WETH may be left in the router for an unwrap; the multicall length is bounded; several swaps share one unwrap", () => {
  assert.match(JSON.stringify(verdict(V.mc_dai_in_router).reasons), /other than WETH/);
  assert.equal(verdict(V.mc_eight).decision, "ALLOW", "eight inner calls is the limit");
  assert.match(JSON.stringify(verdict(V.mc_nine).reasons), /more than 8 calls/);
  const two = decodeEvmTransaction(swapTx(V.mc_two_swaps_unwrap_self)).instructions;
  assert.equal(two.length, 2);
  assert.equal(two.reduce((n, i) => n + (i.amount ?? 0n), 0n), 2_000_000_000n, "both swaps count toward the same cap");
  assert.equal(verdict(V.mc_two_swaps_unwrap_self, tight).decision, "ALLOW", "2000 USDC in total equals the 2000 cap, which is allowed");
  assert.equal(verdict(V.mc_two_swaps_unwrap_self, policyWith("1999999999")).decision, "NEEDS_REVIEW", "one unit over the cap, summed across both swaps");
});

test("uniswap: unwrapWETH9 takes a literal recipient: the swap-style 'sender' constant 0x..01 is a different address there", () => {
  // Measured on a mainnet fork: ETH unwrapped to 0x..01 goes to that address, not to the caller.
  const r = verdict(V.mc_swap_unwrap_magic);
  assert.equal(r.decision, "NEEDS_REVIEW");
  assert.match(JSON.stringify(r.reasons), /0x0000000000000000000000000000000000000001/);
  const d = decodeEvmTransaction(swapTx(V.mc_swap_unwrap_magic)).instructions;
  assert.ok(d.some((i) => i.destination === "0x0000000000000000000000000000000000000001"));
});

test("uniswap: a multicall deadline further away than the policy's limit goes to review", () => {
  const deadline = routerDeadline(1, ROUTER, V.mc_swap_unwrap_self);
  assert.notEqual(deadline, undefined, "multicall(uint256,bytes[]) carries a deadline");
  const at = (secondsBefore: bigint) => evaluateEvmTransaction(swapTx(V.mc_swap_unwrap_self), tight, {}, Number(deadline! - secondsBefore));
  assert.equal(at(600n).decision, "ALLOW", "ten minutes of life is normal");
  assert.equal(at(86_400n).decision, "ALLOW", "exactly the limit is allowed");
  const far = at(86_401n);
  assert.equal(far.decision, "NEEDS_REVIEW");
  assert.match(JSON.stringify(far.reasons), /router deadline is 86401 seconds away/);
  assert.equal(routerDeadline(1, ROUTER, V.mc_swap_refund), undefined, "multicall(bytes[]) has no deadline argument");
  assert.equal(routerDeadline(1, ROUTER, V.eis_self), undefined);
  assert.equal(routerDeadline(1, USDC, V.mc_swap_unwrap_self), undefined, "only a known router is read");
});
