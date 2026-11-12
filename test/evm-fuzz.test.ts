import test from "node:test";
import assert from "node:assert/strict";
import { decodeEvmTransaction } from "../src/evm/decode.js";
import { evaluateEvmTransaction } from "../src/evm/evaluate.js";
import { decodeEvmTypedData, evaluateEvmTypedData } from "../src/evm/typed-data.js";
import { SWAP_ROUTERS } from "../src/evm/uniswap.js";
import { parsePolicy } from "../src/policy/validate.js";
import { V } from "./evm-uniswap-vectors.js";

// Deterministic generator so a failure can be reproduced from its seed.
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }

const ROUTER = SWAP_ROUTERS[1].router;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const agent = "0x1111111111111111111111111111111111111111";
const vendor = "0x2222222222222222222222222222222222222222";
const attacker = "0x3333333333333333333333333333333333333333";
const policy = parsePolicy({
  policyId: "fuzz", programAllowlist: ["evm:native", USDC, ROUTER], destinationAllowlist: [vendor, ROUTER],
  maxAmountPerTransaction: { native: "1000000000000000000", [USDC]: "1000000000" }, maxAmountPerDay: { native: "3000000000000000000", [USDC]: "3000000000" },
  allowedChainIds: [1]
});
const inList = (l: string[], a: string) => l.map((x) => x.toLowerCase()).includes(a.toLowerCase());

const hex = (r: () => number, bytes: number) => Array.from({ length: bytes }, () => Math.floor(r() * 256).toString(16).padStart(2, "0")).join("");
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.slice(2).padStart(64, "0");

const SELECTORS = ["a9059cbb", "095ea7b3", "39509351", "23b872dd", "a22cb465", "d0e30db0", "2e1a7d4d", "04e45aaf", "b858183f", "5023b4df", "09b81346", "5ae401dc", "ac9650d8", "1f0464d1", "49404b7c", "12210e8a", "deadbeef"];
const ADDRS = [vendor, attacker, agent, ROUTER, USDC, "0x0000000000000000000000000000000000000000", "0x0000000000000000000000000000000000000001", "0xffffffffffffffffffffffffffffffffffffffff"];
const AMOUNTS = [0n, 1n, 999_999_999n, 1_000_000_000n, 1_000_000_001n, 10n ** 18n, 10n ** 18n + 1n, 2n ** 160n - 1n, 2n ** 256n - 1n];

function randomTx(r: () => number) {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const kind = r();
  let data: string | undefined;
  if (kind < 0.15) data = undefined;
  else if (kind < 0.25) data = "0x";
  else if (kind < 0.35) data = `0x${hex(r, Math.floor(r() * 80))}`;
  else if (kind < 0.45) data = pick(Object.values(V)); // real Uniswap calldata, sometimes mutated below
  else {
    const body = Array.from({ length: Math.floor(r() * 5) }, () => (r() < 0.5 ? addrWord(pick(ADDRS)) : r() < 0.8 ? word(pick(AMOUNTS)) : hex(r, 32))).join("");
    data = `0x${pick(SELECTORS)}${body}${r() < 0.2 ? hex(r, Math.floor(r() * 40)) : ""}`;
  }
  if (data && r() < 0.15) { const i = 2 + Math.floor(r() * (data.length - 2)); data = data.slice(0, i) + pick(["0", "f", "A", "g"]) + data.slice(i + 1); }
  if (data && r() < 0.05) data = data.toUpperCase().replace("0X", "0x");
  return {
    chainId: pick([1, 1, 1, 10, 0, -1, 2 ** 40]),
    from: r() < 0.9 ? agent : pick(["", "0x12", agent.toUpperCase().replace("0X", "0x")]),
    to: r() < 0.05 ? undefined : r() < 0.05 ? pick(["0x", "zz", vendor.slice(0, 20)]) : pick(ADDRS),
    value: r() < 0.7 ? 0n : pick(AMOUNTS),
    data
  };
}

test("fuzz: the transaction evaluator never throws, and ALLOW always matches the policy", () => {
  const r = rng(20261023);
  let allowed = 0;
  for (let i = 0; i < 30_000; i++) {
    const tx = randomTx(r);
    let evaluation;
    let summary;
    try {
      evaluation = evaluateEvmTransaction(tx, policy, {}, 1_893_456_000 - 600);
      summary = decodeEvmTransaction(tx);
    } catch (e) { assert.fail(`threw on ${JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}: ${String(e)}`); }
    if (evaluation.decision !== "ALLOW") continue;
    allowed++;
    const why = `${JSON.stringify(tx, (_k, v) => (typeof v === "bigint" ? v.toString() : v))} -> ${JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`;
    // Calldata-level rule that does not rely on the decoder: granting an operator a whole collection is never automatic.
    const d = (tx.data ?? "0x").toLowerCase();
    assert.ok(!(d.startsWith("0xa22cb465") && /1$/.test(d.slice(10, 138))), `ALLOW of setApprovalForAll(true): ${why}`);
    assert.equal(tx.chainId, 1, `ALLOW on a chain the policy does not list: ${why}`);
    assert.ok(summary.instructions.length > 0, `ALLOW with no instructions: ${why}`);
    for (const ins of summary.instructions) {
      assert.notEqual(ins.mode, "raw_dump", `ALLOW with a raw_dump: ${why}`);
      assert.ok(inList(policy.programAllowlist, ins.programId), `ALLOW with a program outside the allowlist: ${why}`);
      if (ins.destination !== undefined) assert.ok(inList(policy.destinationAllowlist, ins.destination), `ALLOW to a destination outside the allowlist: ${why}`);
      if (ins.amount !== undefined && ins.asset !== undefined && ins.amount > 0n) {
        const cap = policy.maxAmountPerTransaction[ins.asset];
        assert.ok(cap !== undefined && ins.amount <= BigInt(cap), `ALLOW above the per-transaction cap: ${why}`);
      }
    }
  }
  console.log(`# fuzz transactions: ${allowed} of 30000 reached ALLOW`);
  assert.ok(allowed > 50, `the generator should reach ALLOW sometimes (got ${allowed}), otherwise the invariants prove nothing`);
});

test("fuzz: typed-data evaluator never throws on malformed requests, and ALLOW needs an allowlisted spender", () => {
  const r = rng(77);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const junk = () => pick<unknown>([undefined, null, 1, -1, "x", "0x", "", [], {}, [1], { a: 1 }, 2n ** 70n === 0n ? 0 : "115792089237316195423570985008687907853269984665640564039457584007913129639936", USDC, vendor, attacker, true]);
  let allowed = 0;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 20_000; i++) {
    const good = r() < 0.85;
    const message: Record<string, unknown> = good
      ? { owner: agent, spender: pick([vendor, attacker]), value: pick(["1", "500000000", "1000000000", "1000000001", "0x10"]), nonce: "0", deadline: String(now + pick([60, 3600, 86_400, 86_401, 10 ** 9])) }
      : Object.fromEntries(["owner", "spender", "value", "nonce", "deadline"].map((k) => [k, junk()]));
    const request = {
      from: r() < 0.85 ? agent : pick([attacker, "", "0x1"]),
      typedData: {
        domain: pick<Record<string, unknown>>([{ chainId: 1, verifyingContract: USDC }, { chainId: 1, verifyingContract: USDC }, { chainId: 1, verifyingContract: USDC }, { chainId: "1", verifyingContract: USDC }, { verifyingContract: USDC }, { chainId: 1 }, { chainId: 137, verifyingContract: USDC }, {}]),
        types: pick<Record<string, { name: string; type: string }[]>>([
          { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
          { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
          { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
          { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "nonce", type: "uint256" }] },
          {}, { Permit: [] }
        ]),
        primaryType: pick(["Permit", "Permit", "Permit", "Permit", "PermitSingle", "Other", ""]),
        message
      }
    };
    let evaluation;
    try { evaluation = evaluateEvmTypedData(request as never, policy, {}, now); decodeEvmTypedData(request as never); }
    catch (e) { assert.fail(`threw on ${JSON.stringify(request)}: ${String(e)}`); }
    if (evaluation.decision !== "ALLOW") continue;
    allowed++;
    assert.equal(request.from, agent);
    assert.ok(inList(policy.destinationAllowlist, String(message.spender)), `ALLOW with spender outside the allowlist: ${JSON.stringify(request)}`);
    assert.ok(BigInt(String(message.value)) <= 1_000_000_000n, `ALLOW above the cap: ${JSON.stringify(request)}`);
    assert.ok(BigInt(String(message.deadline)) - BigInt(now) <= 86_400n, `ALLOW with a long-lived permit: ${JSON.stringify(request)}`);
  }
  console.log(`# fuzz typed data: ${allowed} of 20000 reached ALLOW`);
  assert.ok(allowed > 20, `the generator should reach ALLOW sometimes (got ${allowed})`);
});
