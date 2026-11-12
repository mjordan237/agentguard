import test from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3";
import { decodeEvmTransaction } from "../src/evm/decode.js";

// Runs only with EVM_FORK_RPC set to an anvil node forked from Ethereum mainnet (see README "EVM fork test").
// Sends real transactions on the fork and checks that what the decoder says a call moves is what actually moved.
const RPC = process.env.EVM_FORK_RPC;
const skip = RPC ? false : "set EVM_FORK_RPC to an anvil mainnet fork to run";

const AGENT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"; // anvil account 0, unlocked
const VENDOR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8"; // anvil account 1
// Anvil's well-known accounts are EIP-7702-delegated on mainnet and forward received ETH, so native transfers go to a clean address.
const CLEAN = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const BAYC = "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d";

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addr = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sel = (s: string) => hexOf(keccak_256(new TextEncoder().encode(s))).slice(0, 8);

let id = 0;
async function rpc(method: string, params: unknown[] = []): Promise<any> {
  const r = await fetch(RPC!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const call = async (to: string, data: string) => BigInt(await rpc("eth_call", [{ to, data }, "latest"]));
const balanceOf = (token: string, who: string) => call(token, `0x${sel("balanceOf(address)")}${addr(who)}`);
const allowance = (token: string, owner: string, spender: string) => call(token, `0x${sel("allowance(address,address)")}${addr(owner)}${addr(spender)}`);
const nativeBalance = async (who: string) => BigInt(await rpc("eth_getBalance", [who, "latest"]));

async function send(tx: { to: string; value?: bigint; data?: string }) {
  const hash = await rpc("eth_sendTransaction", [{ from: AGENT, to: tx.to, value: tx.value ? `0x${tx.value.toString(16)}` : undefined, data: tx.data, gas: "0x100000" }]);
  let receipt = null;
  for (let i = 0; i < 50 && !receipt; i++) {
    receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (!receipt) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(receipt, `no receipt for ${hash}`);
  assert.equal(receipt.status, "0x1", `transaction ${hash} reverted`);
}

test("fork: native transfer moves exactly the decoded value to the decoded recipient", { skip }, async () => {
  assert.equal(await rpc("eth_getCode", [CLEAN, "latest"]), "0x");
  const tx = { chainId: 1, from: AGENT, to: CLEAN, value: 123_456_789_000_000_000n };
  const d = decodeEvmTransaction(tx).instructions[0];
  const before = await nativeBalance(CLEAN);
  await send({ to: tx.to, value: tx.value });
  assert.equal(d.destination, CLEAN);
  assert.equal(d.asset, "native");
  assert.equal((await nativeBalance(CLEAN)) - before, d.amount);
});

test("fork: USDC transfer moves exactly the decoded amount to the decoded recipient", { skip }, async () => {
  // Fund the agent by writing the USDC balance slot (balances mapping is slot 9 in FiatTokenV2).
  const slot = `0x${hexOf(keccak_256(Buffer.from(addr(AGENT) + word(9n), "hex")))}`;
  await rpc("anvil_setStorageAt", [USDC, slot, `0x${word(5_000_000_000n)}`]);
  assert.equal(await balanceOf(USDC, AGENT), 5_000_000_000n);

  const data = `0x${sel("transfer(address,uint256)")}${addr(VENDOR)}${word(1_234_567_890n)}`;
  const d = decodeEvmTransaction({ chainId: 1, from: AGENT, to: USDC, data }).instructions[0];
  const before = await balanceOf(USDC, VENDOR);
  await send({ to: USDC, data });
  assert.equal(d.destination, VENDOR);
  assert.equal(d.asset, USDC);
  assert.equal((await balanceOf(USDC, VENDOR)) - before, d.amount);
  assert.equal(await balanceOf(USDC, AGENT), 5_000_000_000n - 1_234_567_890n);
});

test("fork: USDC approve sets exactly the decoded allowance for the decoded spender", { skip }, async () => {
  const data = `0x${sel("approve(address,uint256)")}${addr(VENDOR)}${word(777_000_000n)}`;
  const d = decodeEvmTransaction({ chainId: 1, from: AGENT, to: USDC, data }).instructions[0];
  await send({ to: USDC, data });
  assert.equal(d.destination, VENDOR);
  assert.equal(await allowance(USDC, AGENT, VENDOR), d.amount);
});

test("fork: an unlimited approve really is unlimited, and the decoder reports the full amount", { skip }, async () => {
  const max = (1n << 256n) - 1n;
  const data = `0x${sel("approve(address,uint256)")}${addr(VENDOR)}${word(max)}`;
  const d = decodeEvmTransaction({ chainId: 1, from: AGENT, to: USDC, data }).instructions[0];
  await send({ to: USDC, data });
  assert.equal(d.amount, max);
  assert.equal(await allowance(USDC, AGENT, VENDOR), max);
});

test("fork: WETH deposit wraps exactly the decoded native value", { skip }, async () => {
  const value = 2_500_000_000_000_000_000n;
  const data = `0x${sel("deposit()")}`;
  const d = decodeEvmTransaction({ chainId: 1, from: AGENT, to: WETH, value, data }).instructions[0];
  const before = await balanceOf(WETH, AGENT);
  await send({ to: WETH, value, data });
  assert.equal(d.amount, value);
  assert.equal((await balanceOf(WETH, AGENT)) - before, d.amount);
});

test("fork: setApprovalForAll(true) on a real NFT contract really grants the operator, and the decoder flags it", { skip }, async () => {
  const data = `0x${sel("setApprovalForAll(address,bool)")}${addr(VENDOR)}${word(1n)}`;
  const d = decodeEvmTransaction({ chainId: 1, from: AGENT, to: BAYC, data }).instructions[0];
  assert.equal(d.mode, "raw_dump", "the decoder must not treat a blanket grant as routine");
  await send({ to: BAYC, data });
  const approved = await call(BAYC, `0x${sel("isApprovedForAll(address,address)")}${addr(AGENT)}${addr(VENDOR)}`);
  assert.equal(approved, 1n);
});

test("fork: a transferFrom whose source is the sender moves the decoded amount; a third-party source is flagged", { skip }, async () => {
  const third = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
  const pull = (source: string, to: string, n: bigint) => `0x${sel("transferFrom(address,address,uint256)")}${addr(source)}${addr(to)}${word(n)}`;

  const flagged = decodeEvmTransaction({ chainId: 1, from: AGENT, to: USDC, data: pull(third, VENDOR, 1n) });
  assert.equal(flagged.instructions[0].mode, "raw_dump");

  // USDC makes even the owner pass the allowance check, so give the agent an allowance over itself first.
  await send({ to: USDC, data: `0x${sel("approve(address,uint256)")}${addr(AGENT)}${word(10_000_000n)}` });
  const data = pull(AGENT, third, 1_000_000n);
  const d = decodeEvmTransaction({ chainId: 1, from: AGENT, to: USDC, data }).instructions[0];
  assert.equal(d.mode, "interpolated");
  const before = await balanceOf(USDC, third);
  await send({ to: USDC, data });
  assert.equal(d.destination, third);
  assert.equal((await balanceOf(USDC, third)) - before, d.amount);
});
