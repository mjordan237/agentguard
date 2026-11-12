import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { keccak_256 } from "@noble/hashes/sha3";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { LocalKeySigner } from "../src/evm/sign.js";
import { buildDemoRegistry } from "../demo/policy.js";

// Runs only with EVM_FORK_RPC set to an anvil node forked from Ethereum mainnet (see README "EVM fork test").
// Asks the gate to sign real transactions, broadcasts exactly the bytes it returns, and checks the chain agrees.
const RPC = process.env.EVM_FORK_RPC;
const skip = RPC ? false : "set EVM_FORK_RPC to an anvil mainnet fork to run";

const signer = new LocalKeySigner(keccak_256(new TextEncoder().encode("agentguard evm gate signer fork key")));
const VENDOR = "0x6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b"; // a clean account, different from the one in evm-fork.test.ts (well-known test addresses are 7702-delegated on mainnet)
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
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
const balanceOf = async (who: string) => BigInt(await rpc("eth_call", [{ to: USDC, data: `0x${sel("balanceOf(address)")}${addr(who)}` }, "latest"]));

async function gate() {
  const customers = new CustomerStore();
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, {
    policyId: "fork", programAllowlist: ["evm:native", USDC], destinationAllowlist: [VENDOR],
    maxAmountPerTransaction: { native: String(ETH), [USDC]: "1000000000", "evm:gas": String(ETH) },
    maxAmountPerDay: { native: String(10n * ETH), [USDC]: "5000000000", "evm:gas": String(5n * ETH) }, allowedChainIds: [1]
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const app = createServer(new Map(), buildDemoRegistry(), { baseUrl: "http://x", reviewActionSecret: "s", customers, reviewers: new ReviewerStore(), evmSigner: signer });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const sign = async (transaction: object) => {
    const r = await fetch(`${base}/gate-and-sign-evm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ agentId: "a", policyId: "fork", transaction }) });
    return (await r.json()) as any;
  };
  return { sign, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

async function fees() {
  const price = BigInt(await rpc("eth_gasPrice"));
  return { maxFeePerGas: String(price * 2n + 1_000_000_000n), maxPriorityFeePerGas: "1000000000" };
}
async function broadcast(raw: string) {
  const hash = await rpc("eth_sendRawTransaction", [raw]);
  let receipt = null;
  for (let i = 0; i < 50 && !receipt; i++) { receipt = await rpc("eth_getTransactionReceipt", [hash]); if (!receipt) await new Promise((r) => setTimeout(r, 100)); }
  assert.ok(receipt, "no receipt");
  return { receipt, tx: await rpc("eth_getTransactionByHash", [hash]) };
}

test("fork: a native transfer signed by the gate is accepted by the chain, from the signer, for the right value", { skip }, async () => {
  await rpc("anvil_setBalance", [signer.address, `0x${(5n * ETH).toString(16)}`]);
  const g = await gate();
  try {
    const nonce = BigInt(await rpc("eth_getTransactionCount", [signer.address, "latest"]));
    const before = BigInt(await rpc("eth_getBalance", [VENDOR, "latest"]));
    const r = await g.sign({ chainId: 1, from: signer.address, to: VENDOR, value: String(ETH / 4n), nonce: String(nonce), gasLimit: "21000", ...(await fees()) });
    assert.equal(r.decision, "ALLOW", JSON.stringify(r));
    const { receipt, tx } = await broadcast(r.signedTransaction);
    assert.equal(receipt.status, "0x1");
    assert.equal(tx.from.toLowerCase(), signer.address, "the chain recovers the signer's address from the signature");
    assert.equal(tx.type, "0x2");
    assert.equal(BigInt(await rpc("eth_getBalance", [VENDOR, "latest"])) - before, ETH / 4n);
  } finally { await g.close(); }
});

test("fork: a USDC transfer signed by the gate moves exactly the amount the gate decoded", { skip }, async () => {
  await rpc("anvil_setBalance", [signer.address, `0x${(5n * ETH).toString(16)}`]);
  const slot = `0x${hex(keccak_256(Buffer.from(addr(signer.address) + word(9n), "hex")))}`; // USDC balances mapping is slot 9
  await rpc("anvil_setStorageAt", [USDC, slot, `0x${word(2_000_000_000n)}`]);
  const g = await gate();
  try {
    const nonce = BigInt(await rpc("eth_getTransactionCount", [signer.address, "latest"]));
    const before = await balanceOf(VENDOR);
    const r = await g.sign({ chainId: 1, from: signer.address, to: USDC, data: `0x${sel("transfer(address,uint256)")}${addr(VENDOR)}${word(750_000_000n)}`, nonce: String(nonce), gasLimit: "100000", ...(await fees()) });
    assert.equal(r.decision, "ALLOW", JSON.stringify(r));
    const { receipt } = await broadcast(r.signedTransaction);
    assert.equal(receipt.status, "0x1");
    assert.equal((await balanceOf(VENDOR)) - before, 750_000_000n);
    assert.equal(await balanceOf(signer.address), 1_250_000_000n);
  } finally { await g.close(); }
});

test("fork: an unlimited approval is not signed, and nothing reaches the chain", { skip }, async () => {
  const g = await gate();
  try {
    const nonce = BigInt(await rpc("eth_getTransactionCount", [signer.address, "latest"]));
    const max = (1n << 256n) - 1n;
    const r = await g.sign({ chainId: 1, from: signer.address, to: USDC, data: `0x${sel("approve(address,uint256)")}${addr(VENDOR)}${word(max)}`, nonce: String(nonce), gasLimit: "100000", ...(await fees()) });
    assert.equal(r.decision, "NEEDS_REVIEW");
    assert.equal(r.signedTransaction, undefined);
    assert.equal(BigInt(await rpc("eth_getTransactionCount", [signer.address, "latest"])), nonce);
  } finally { await g.close(); }
});
