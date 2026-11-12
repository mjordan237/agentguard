import test from "node:test";
import assert from "node:assert/strict";
import { evaluateEvmTypedData, decodeEvmTypedData, PERMIT2, type TypedDataRequest } from "../src/evm/typed-data.js";
import { parsePolicy } from "../src/policy/validate.js";

const agent = "0x1111111111111111111111111111111111111111";
const vendor = "0x2222222222222222222222222222222222222222";
const attacker = "0x3333333333333333333333333333333333333333";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const dai = "0x6b175474e89094c44da98b954eedeac495271d0f";
const weth = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const MAX160 = (1n << 160n) - 1n;
const MAX256 = (1n << 256n) - 1n;
const NOW = 1_800_000_000;
const FAR = String(NOW + 3600); // valid for one hour

const policy = parsePolicy({
  policyId: "evm-sign", programAllowlist: [usdc, dai, PERMIT2], destinationAllowlist: [vendor],
  maxAmountPerTransaction: { [usdc]: "1000000000", [dai]: "1000000000000000000000", [weth]: "1000000000000000000" },
  maxAmountPerDay: { [usdc]: "3000000000", [dai]: "3000000000000000000000", [weth]: "3000000000000000000" },
  allowedChainIds: [1]
});
const check = (r: TypedDataRequest, daily: Record<string, bigint> = {}, p = policy) => evaluateEvmTypedData(r, p, daily, NOW);

const PERMIT_TYPES = { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
const erc2612 = (over: Record<string, unknown> = {}, domain: Record<string, unknown> = {}): TypedDataRequest => ({
  from: agent,
  typedData: { domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: usdc, ...domain }, types: PERMIT_TYPES, primaryType: "Permit",
    message: { owner: agent, spender: vendor, value: "500000000", nonce: "0", deadline: FAR, ...over } }
});

const DETAILS = [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }];
const p2domain = { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 };
const detail = (token: string, amount: string) => ({ token, amount, expiration: FAR, nonce: "0" });
const single = (token: string, amount: string, spender = vendor, domain: Record<string, unknown> = p2domain): TypedDataRequest => ({
  from: agent,
  typedData: { domain, primaryType: "PermitSingle",
    types: { PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }], PermitDetails: DETAILS },
    message: { details: detail(token, amount), spender, sigDeadline: FAR } }
});
const batch = (items: { token: string; amount: string }[]): TypedDataRequest => ({
  from: agent,
  typedData: { domain: p2domain, primaryType: "PermitBatch",
    types: { PermitBatch: [{ name: "details", type: "PermitDetails[]" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }], PermitDetails: DETAILS },
    message: { details: items.map((i) => detail(i.token, i.amount)), spender: vendor, sigDeadline: FAR } }
});
const TP = [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }];
const transferFrom = (token: string, amount: string): TypedDataRequest => ({
  from: agent,
  typedData: { domain: p2domain, primaryType: "PermitTransferFrom",
    types: { PermitTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }], TokenPermissions: TP },
    message: { permitted: { token, amount }, spender: vendor, nonce: "7", deadline: FAR } }
});

test("typed data: an ERC-2612 permit follows spender, token, amount and signer rules", () => {
  assert.equal(check(erc2612()).decision, "ALLOW");
  assert.equal(check(erc2612({ spender: attacker })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({ value: MAX256.toString() })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({ value: "2000000000" })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({ owner: vendor })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({}, { verifyingContract: weth })).decision, "NEEDS_REVIEW", "token not in the contract allowlist");
});

test("typed data: Permit2 PermitSingle follows the same rules, on the real Permit2 only", () => {
  assert.equal(check(single(usdc, "500000000")).decision, "ALLOW");
  assert.equal(check(single(usdc, "500000000", attacker)).decision, "NEEDS_REVIEW");
  assert.equal(check(single(usdc, MAX160.toString())).decision, "NEEDS_REVIEW");
  assert.equal(check(single(usdc, "500000000", vendor, { ...p2domain, verifyingContract: attacker })).decision, "NEEDS_REVIEW");
  assert.equal(check(single(usdc, (MAX160 + 1n).toString())).decision, "NEEDS_REVIEW", "out of uint160 range is malformed");
});

test("typed data: Permit2 batches are summed per asset and every entry is checked", () => {
  assert.equal(check(batch([{ token: usdc, amount: "400000000" }, { token: dai, amount: "1" }])).decision, "ALLOW");
  assert.equal(check(batch([{ token: usdc, amount: "600000000" }, { token: usdc, amount: "600000000" }])).decision, "NEEDS_REVIEW", "600M + 600M passes each entry but breaks the 1000M cap");
  assert.equal(check(batch([{ token: usdc, amount: "1" }, { token: weth, amount: "1" }])).decision, "ALLOW", "weth has caps configured");
  const uncapped = "0x9999999999999999999999999999999999999999";
  assert.equal(check(batch([{ token: usdc, amount: "1" }, { token: uncapped, amount: "1" }])).decision, "NEEDS_REVIEW", "a token with no configured cap is unknown, not unlimited");
});

test("typed data: Permit2 signature transfers are evaluated; witness variants are not understood and go to review", () => {
  assert.equal(check(transferFrom(usdc, "500000000")).decision, "ALLOW");
  assert.equal(check(transferFrom(usdc, "5000000000")).decision, "NEEDS_REVIEW");
  const witness = transferFrom(usdc, "1");
  witness.typedData.primaryType = "PermitWitnessTransferFrom";
  assert.equal(check(witness).decision, "NEEDS_REVIEW");
});

test("typed data: a declared layout that differs from the standard one is not evaluated as that type", () => {
  const extra = erc2612();
  extra.typedData.types = { Permit: [...PERMIT_TYPES.Permit, { name: "memo", type: "bytes32" }] };
  assert.equal(check(extra).decision, "NEEDS_REVIEW");
  const swapped = erc2612();
  swapped.typedData.types = { Permit: [PERMIT_TYPES.Permit[1], PERMIT_TYPES.Permit[0], ...PERMIT_TYPES.Permit.slice(2)] };
  assert.equal(check(swapped).decision, "NEEDS_REVIEW");
  const retyped = erc2612();
  retyped.typedData.types = { Permit: PERMIT_TYPES.Permit.map((f) => (f.name === "value" ? { name: "value", type: "uint8" } : f)) };
  assert.equal(check(retyped).decision, "NEEDS_REVIEW");
});

test("typed data: a DAI-style permit with allowed=true is unlimited; revoking is fine", () => {
  const daiPermit = (allowed: boolean): TypedDataRequest => ({
    from: agent,
    typedData: { domain: { name: "Dai Stablecoin", version: "1", chainId: 1, verifyingContract: dai }, primaryType: "Permit",
      types: { Permit: [{ name: "holder", type: "address" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "allowed", type: "bool" }] },
      message: { holder: agent, spender: vendor, nonce: "0", expiry: FAR, allowed } }
  });
  assert.equal(check(daiPermit(true)).decision, "NEEDS_REVIEW");
  assert.equal(check(daiPermit(false)).decision, "ALLOW");
});

test("typed data: unknown signature types, bad chain ids and malformed numbers go to review", () => {
  const unknown = erc2612();
  unknown.typedData.primaryType = "SetOwner";
  assert.equal(check(unknown).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({}, { chainId: 137 })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({}, { chainId: undefined })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({ value: "-5" })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({ value: 1.5 })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({ value: { evil: true } })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({ deadline: undefined })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({ value: "0x1dcd6500" })).decision, "ALLOW", "hex amounts are read correctly (500000000)");
});

test("typed data: permit allowances count toward the daily cap", () => {
  assert.equal(check(erc2612({ value: "500000000" }), { [usdc]: 2_500_000_000n }).decision, "ALLOW");
  assert.equal(check(erc2612({ value: "500000001" }), { [usdc]: 2_500_000_000n }).decision, "NEEDS_REVIEW");
});

test("typed data: the decoded summary reports the spender, token and amount", () => {
  const d = decodeEvmTypedData(single(usdc, "123")).instructions[0];
  assert.equal(d.destination, vendor);
  assert.equal(d.asset, usdc);
  assert.equal(d.amount, 123n);
});

test("typed data: a permit that stays valid longer than the policy allows goes to review (24 hours by default)", () => {
  assert.equal(check(erc2612({ deadline: String(NOW + 86_400) })).decision, "ALLOW", "exactly 24 hours is within the default");
  assert.equal(check(erc2612({ deadline: String(NOW + 86_401) })).decision, "NEEDS_REVIEW");
  assert.equal(check(erc2612({ deadline: "9999999999" })).decision, "NEEDS_REVIEW", "a permit valid until the year 2286");
  assert.equal(check(erc2612({ deadline: MAX256.toString() })).decision, "NEEDS_REVIEW", "a permit that never expires");
});

test("typed data: both the signature deadline and the Permit2 allowance expiry are bounded", () => {
  const r = single(usdc, "1");
  assert.equal(check(r).decision, "ALLOW");
  (r.typedData.message as any).details.expiration = "9999999999"; // allowance outlives the signature
  assert.equal(check(r).decision, "NEEDS_REVIEW");
  const b = batch([{ token: usdc, amount: "1" }, { token: dai, amount: "1" }]);
  (b.typedData.message as any).details[1].expiration = "9999999999"; // one entry in a batch
  assert.equal(check(b).decision, "NEEDS_REVIEW");
  const t = transferFrom(usdc, "1");
  (t.typedData.message as any).deadline = "9999999999";
  assert.equal(check(t).decision, "NEEDS_REVIEW");
});

test("typed data: the policy can set its own lifetime limit; an already expired permit is harmless", () => {
  const tight = parsePolicy({ ...policy, maxPermitLifetimeSeconds: 600 });
  assert.equal(check(erc2612(), {}, tight).decision, "NEEDS_REVIEW", "one hour is longer than ten minutes");
  assert.equal(check(erc2612({ deadline: String(NOW + 600) }), {}, tight).decision, "ALLOW");
  const loose = parsePolicy({ ...policy, maxPermitLifetimeSeconds: 10_000_000_000 });
  assert.equal(check(erc2612({ deadline: "9999999999" }), {}, loose).decision, "ALLOW");
  assert.equal(check(erc2612({ deadline: String(NOW - 5) })).decision, "ALLOW");
});
