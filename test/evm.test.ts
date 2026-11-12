import test from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { evaluateEvmTransaction } from "../src/evm/evaluate.js";
import { decodeEvmTransaction, type EvmTransaction } from "../src/evm/decode.js";
import { parsePolicy } from "../src/policy/validate.js";

const ETH = 10n ** 18n;
const agent = "0x1111111111111111111111111111111111111111";
const vendor = "0x2222222222222222222222222222222222222222";
const attacker = "0x3333333333333333333333333333333333333333";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const nft = "0x4444444444444444444444444444444444444444";

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const call = (sel: string, ...args: string[]) => `0x${sel}${args.join("")}`;
const sig = (s: string) => Buffer.from(keccak_256(new TextEncoder().encode(s))).toString("hex").slice(0, 8);

const policy = parsePolicy({
  policyId: "evm-pay",
  programAllowlist: ["evm:native", usdc.toUpperCase().replace("0X", "0x"), nft],
  destinationAllowlist: [vendor],
  maxAmountPerTransaction: { native: String(ETH), [usdc]: "1000000000" },
  maxAmountPerDay: { native: String(3n * ETH), [usdc]: "3000000000" },
  allowedChainIds: [1, 8453]
});
const tx = (over: Partial<EvmTransaction>): EvmTransaction => ({ chainId: 1, from: agent, ...over });
const review = (t: EvmTransaction, daily: Record<string, bigint> = {}) => evaluateEvmTransaction(t, policy, daily);

test("evm: the hard-coded selectors are the keccak of the function signatures", () => {
  assert.equal(sig("transfer(address,uint256)"), "a9059cbb");
  assert.equal(sig("approve(address,uint256)"), "095ea7b3");
  assert.equal(sig("increaseAllowance(address,uint256)"), "39509351");
  assert.equal(sig("transferFrom(address,address,uint256)"), "23b872dd");
  assert.equal(sig("setApprovalForAll(address,bool)"), "a22cb465");
  assert.equal(sig("deposit()"), "d0e30db0");
  assert.equal(sig("withdraw(uint256)"), "2e1a7d4d");
});

test("evm: allowlist entries are matched case-insensitively", () => {
  assert.ok(policy.programAllowlist.includes(usdc));
  assert.equal(review(tx({ to: vendor, value: ETH / 2n })).decision, "ALLOW");
});

test("evm: native transfer to the vendor is allowed; to anyone else goes to review", () => {
  assert.equal(review(tx({ to: vendor, value: ETH / 2n })).decision, "ALLOW");
  assert.equal(review(tx({ to: attacker, value: 1n })).decision, "NEEDS_REVIEW");
  assert.equal(review(tx({ to: vendor, value: 2n * ETH })).decision, "NEEDS_REVIEW");
});

test("evm: ERC-20 transfer follows recipient and cap rules", () => {
  const pay = (to: string, amount: bigint) => tx({ to: usdc, data: call("a9059cbb", addr(to), word(amount)) });
  assert.equal(review(pay(vendor, 500_000_000n)).decision, "ALLOW");
  assert.equal(review(pay(attacker, 1n)).decision, "NEEDS_REVIEW");
  assert.equal(review(pay(vendor, 2_000_000_000n)).decision, "NEEDS_REVIEW");
});

test("evm: unlimited approval is not allowed, and approval to an unlisted spender is not allowed", () => {
  const max = (1n << 256n) - 1n;
  assert.equal(review(tx({ to: usdc, data: call("095ea7b3", addr(vendor), word(max)) })).decision, "NEEDS_REVIEW");
  assert.equal(review(tx({ to: usdc, data: call("095ea7b3", addr(attacker), word(1n)) })).decision, "NEEDS_REVIEW");
  assert.equal(review(tx({ to: usdc, data: call("39509351", addr(vendor), word(max)) })).decision, "NEEDS_REVIEW");
  assert.equal(review(tx({ to: usdc, data: call("095ea7b3", addr(vendor), word(100_000_000n)) })).decision, "ALLOW");
});

test("evm: setApprovalForAll(true) always needs a person; revoking is fine", () => {
  const grant = review(tx({ to: nft, data: call("a22cb465", addr(vendor), word(1n)) }));
  assert.equal(grant.decision, "NEEDS_REVIEW");
  assert.equal(review(tx({ to: nft, data: call("a22cb465", addr(attacker), word(1n)) })).decision, "NEEDS_REVIEW");
  assert.equal(review(tx({ to: nft, data: call("a22cb465", addr(attacker), word(0n)) })).decision, "ALLOW");
});

test("evm: transferFrom from a third party needs review; from the sender follows the transfer rules", () => {
  const from = (src: string, to: string, n: bigint) => tx({ to: usdc, data: call("23b872dd", addr(src), addr(to), word(n)) });
  assert.equal(review(from("0x5555555555555555555555555555555555555555", vendor, 1n)).decision, "NEEDS_REVIEW");
  assert.equal(review(from(agent, vendor, 1_000_000n)).decision, "ALLOW");
  assert.equal(review(from(agent, attacker, 1_000_000n)).decision, "NEEDS_REVIEW");
});

test("evm: unknown functions, malformed calldata and dirty address words go to review", () => {
  assert.equal(review(tx({ to: usdc, data: "0xdeadbeef" })).decision, "NEEDS_REVIEW");
  assert.equal(review(tx({ to: usdc, data: call("a9059cbb", addr(vendor)) })).decision, "NEEDS_REVIEW"); // one word short
  assert.equal(review(tx({ to: usdc, data: call("a9059cbb", addr(vendor), word(1n), "00") })).decision, "NEEDS_REVIEW"); // trailing byte
  const dirty = "ff" + addr(vendor).slice(2);
  assert.equal(review(tx({ to: usdc, data: call("a9059cbb", dirty, word(1n)) })).decision, "NEEDS_REVIEW");
  assert.equal(review(tx({ to: usdc, data: "0xzz" })).decision, "NEEDS_REVIEW");
});

test("evm: native value attached to a token call, and contract creation, go to review", () => {
  assert.equal(review(tx({ to: usdc, value: 1n, data: call("a9059cbb", addr(vendor), word(1n)) })).decision, "NEEDS_REVIEW");
  assert.equal(review(tx({ data: "0x6080" })).decision, "NEEDS_REVIEW");
});

test("evm: a chain not in allowedChainIds, or a policy with none, goes to review", () => {
  assert.equal(review(tx({ chainId: 8453, to: vendor, value: 1n })).decision, "ALLOW");
  assert.equal(review(tx({ chainId: 137, to: vendor, value: 1n })).decision, "NEEDS_REVIEW");
  const noChains = parsePolicy({ ...policy, allowedChainIds: undefined });
  assert.equal(evaluateEvmTransaction(tx({ to: vendor, value: 1n }), noChains).decision, "NEEDS_REVIEW");
});

test("evm: the daily cap applies across transactions", () => {
  const t = tx({ to: vendor, value: ETH });
  assert.equal(review(t, { native: 2n * ETH }).decision, "ALLOW");
  assert.equal(review(t, { native: 2n * ETH + 1n }).decision, "NEEDS_REVIEW");
});

test("evm: an empty destination allowlist still fails closed", () => {
  const open = parsePolicy({ ...policy, destinationAllowlist: [] });
  assert.equal(evaluateEvmTransaction(tx({ to: attacker, value: 1n }), open).decision, "NEEDS_REVIEW");
  assert.equal(evaluateEvmTransaction(tx({ to: attacker, value: 1n }), { ...open, allowAnyDestination: true }).decision, "ALLOW");
});

test("evm: decoded amounts match the calldata", () => {
  const d = decodeEvmTransaction(tx({ to: usdc, data: call("a9059cbb", addr(vendor), word(123456789n)) }));
  assert.equal(d.instructions[0].amount, 123456789n);
  assert.equal(d.instructions[0].destination, vendor);
  assert.equal(d.instructions[0].asset, usdc);
});

test("deposit() and withdraw(uint256) are read as WETH only on the chain's WETH contract", () => {
  const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", vault = "0x3333333333333333333333333333333333333333";
  const from = "0x1111111111111111111111111111111111111111";
  const withdraw = `0x2e1a7d4d${(10n ** 18n).toString(16).padStart(64, "0")}`;
  assert.equal(decodeEvmTransaction({ chainId: 1, from, to: weth, data: withdraw }).instructions[0]!.mode, "interpolated");
  assert.equal(decodeEvmTransaction({ chainId: 1, from, to: weth, data: "0xd0e30db0", value: 1n }).instructions[0]!.mode, "interpolated");
  for (const data of [withdraw, "0xd0e30db0"]) {
    const decoded = decodeEvmTransaction({ chainId: 1, from, to: vault, data }).instructions[0]!;
    assert.equal(decoded.mode, "raw_dump");
    assert.match(String(decoded.fields.reason), /only understood on this chain's WETH contract/);
  }
});
