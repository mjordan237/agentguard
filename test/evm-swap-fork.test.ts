import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { keccak_256 } from "@noble/hashes/sha3";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { LocalKeySigner } from "../src/evm/sign.js";
import { SWAP_ROUTERS } from "../src/evm/uniswap.js";
import { buildDemoRegistry } from "../demo/policy.js";

// Runs only with EVM_FORK_RPC set to an anvil node forked from Ethereum mainnet (see README "EVM fork test").
// The gate signs real Uniswap SwapRouter02 transactions, the exact bytes are broadcast to the real router, and
// what the chain did is compared with what the gate said the transaction would do.
const RPC = process.env.EVM_FORK_RPC;
const skip = RPC ? false : "set EVM_FORK_RPC to an anvil mainnet fork to run";

const signer = new LocalKeySigner(keccak_256(new TextEncoder().encode("agentguard evm swap fork key")));
const ROUTER = SWAP_ROUTERS[1].router;
const WETH = SWAP_ROUTERS[1].weth;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ATTACKER = "0x7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c";
const ME = "0x0000000000000000000000000000000000000001"; // SwapRouter02 "msg.sender"
const THIS = "0x0000000000000000000000000000000000000002"; // SwapRouter02 "the router"
const ETH = 10n ** 18n;

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sel = (s: string) => hex(keccak_256(new TextEncoder().encode(s))).slice(0, 8);

let id = 0;
async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const r = await fetch(RPC!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const erc20 = async (token: string, who: string) => BigInt(await rpc("eth_call", [{ to: token, data: `0x${sel("balanceOf(address)")}${addr(who)}` }, "latest"]));
const eth = async (who: string) => BigInt(await rpc("eth_getBalance", [who, "latest"]));

// calldata builders
const exactInputSingle = (recipient: string, amountIn: bigint, minOut: bigint) =>
  `${sel("exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))")}${addr(USDC)}${addr(WETH)}${word(500n)}${addr(recipient)}${word(amountIn)}${word(minOut)}${word(0n)}`;
const unwrapWETH9 = (minimum: bigint, recipient: string) => `${sel("unwrapWETH9(uint256,address)")}${word(minimum)}${addr(recipient)}`;
function multicall(deadline: bigint, calls: string[]) {
  const padded = calls.map((c) => c.padEnd(Math.ceil(c.length / 64) * 64, "0"));
  let offset = calls.length * 32;
  const offsets: string[] = [];
  padded.forEach((p, i) => { offsets.push(word(BigInt(offset))); offset += 32 + p.length / 2; });
  const items = calls.map((c, i) => word(BigInt(c.length / 2)) + padded[i]).join("");
  return `0x${sel("multicall(uint256,bytes[])")}${word(deadline)}${word(0x40n)}${word(BigInt(calls.length))}${offsets.join("")}${items}`;
}

async function gate() {
  const customers = new CustomerStore();
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, {
    policyId: "swap", programAllowlist: [ROUTER, USDC], destinationAllowlist: [ROUTER],
    maxAmountPerTransaction: { [USDC]: "2000000000", "evm:gas": String(ETH) }, maxAmountPerDay: { [USDC]: "10000000000", "evm:gas": String(5n * ETH) }, allowedChainIds: [1]
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const app = createServer(new Map(), buildDemoRegistry(), { baseUrl: "http://x", reviewActionSecret: "s", customers, reviewers: new ReviewerStore(), evmSigner: signer });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const sign = async (to: string, data: string) => {
    const nonce = BigInt(await rpc("eth_getTransactionCount", [signer.address, "latest"]));
    const price = BigInt(await rpc("eth_gasPrice"));
    const transaction = { chainId: 1, from: signer.address, to, data, nonce: String(nonce), gasLimit: "500000", maxFeePerGas: String(price * 2n + 1_000_000_000n), maxPriorityFeePerGas: "1000000000" };
    const r = await fetch(`${base}/gate-and-sign-evm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ agentId: "a", policyId: "swap", transaction }) });
    return (await r.json()) as any;
  };
  return { sign, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

async function broadcast(raw: string) {
  const hash = await rpc("eth_sendRawTransaction", [raw]);
  let receipt = null;
  for (let i = 0; i < 50 && !receipt; i++) { receipt = await rpc("eth_getTransactionReceipt", [hash]); if (!receipt) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(receipt, "no receipt");
  assert.equal(receipt.status, "0x1", "the router accepted the transaction");
  return receipt;
}

test("fork: the gate signs real Uniswap swaps; the chain moves exactly what the gate decoded", { skip }, async () => {
  await rpc("anvil_setBalance", [signer.address, `0x${(5n * ETH).toString(16)}`]);
  const slot = `0x${hex(keccak_256(Buffer.from(addr(signer.address) + word(9n), "hex")))}`;
  await rpc("anvil_setStorageAt", [USDC, slot, `0x${word(5_000_000_000n)}`]);
  const g = await gate();
  try {
    // 1. approve the router (spender = the router, which the policy lists)
    const approve = await g.sign(USDC, `0x${sel("approve(address,uint256)")}${addr(ROUTER)}${word(1_500_000_000n)}`);
    assert.equal(approve.decision, "ALLOW", JSON.stringify(approve.reasons));
    await broadcast(approve.signedTransaction);

    // 2. a plain swap USDC -> WETH, output to the signer
    const usdcBefore = await erc20(USDC, signer.address);
    const wethBefore = await erc20(WETH, signer.address);
    const swap = await g.sign(ROUTER, `0x${exactInputSingle(ME, 1_000_000_000n, 1n)}`);
    assert.equal(swap.decision, "ALLOW", JSON.stringify(swap.reasons));
    await broadcast(swap.signedTransaction);
    assert.equal(usdcBefore - (await erc20(USDC, signer.address)), 1_000_000_000n, "exactly the decoded amount left the account");
    assert.ok((await erc20(WETH, signer.address)) > wethBefore, "WETH arrived at the signer");

    // 3. swap to the router, then unwrap to ETH for the signer, in one multicall
    const usdcMid = await erc20(USDC, signer.address);
    const ethBefore = await eth(signer.address);
    const mc = await g.sign(ROUTER, multicall(9999999999n, [exactInputSingle(THIS, 500_000_000n, 1n), unwrapWETH9(1n, signer.address)]));
    assert.equal(mc.decision, "ALLOW", JSON.stringify(mc.reasons));
    const receipt = await broadcast(mc.signedTransaction);
    const gasPaid = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
    assert.equal(usdcMid - (await erc20(USDC, signer.address)), 500_000_000n);
    assert.ok((await eth(signer.address)) + gasPaid > ethBefore, "ETH arrived at the signer after unwrapping");
  } finally { await g.close(); }
});

test("fork: swaps the gate must not sign are not signed, so nothing reaches the router", { skip }, async () => {
  const g = await gate();
  try {
    const nonce = BigInt(await rpc("eth_getTransactionCount", [signer.address, "latest"]));
    for (const [label, data] of [
      ["output to an attacker", `0x${exactInputSingle(ATTACKER, 100_000_000n, 1n)}`],
      ["no minimum output", `0x${exactInputSingle(ME, 100_000_000n, 0n)}`],
      ["output left in the router", `0x${exactInputSingle(THIS, 100_000_000n, 1n)}`],
      ["unwrap to the swap-style sender constant, which on unwrapWETH9 is a different address", multicall(9999999999n, [exactInputSingle(THIS, 100_000_000n, 1n), unwrapWETH9(1n, ME)])],
      ["unwrap to an attacker", multicall(9999999999n, [exactInputSingle(THIS, 100_000_000n, 1n), unwrapWETH9(1n, ATTACKER)])],
      ["sweep call inside a multicall", multicall(9999999999n, [`${sel("sweepToken(address,uint256,address)")}${addr(USDC)}${word(1n)}${addr(ATTACKER)}`])]
    ] as const) {
      const r = await g.sign(ROUTER, data);
      assert.equal(r.decision, "NEEDS_REVIEW", label);
      assert.equal(r.signedTransaction, undefined, label);
    }
    assert.equal(BigInt(await rpc("eth_getTransactionCount", [signer.address, "latest"])), nonce, "no transaction was signed or sent");
    assert.equal(await erc20(USDC, ATTACKER), 0n);
  } finally { await g.close(); }
});
