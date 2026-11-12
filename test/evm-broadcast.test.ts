import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";
import { LocalKeySigner } from "../src/evm/sign.js";
import { rpcBroadcaster } from "../src/evm/broadcast.js";
import { rpcCodeLookup } from "../src/evm/code-check.js";
import { keccak_256 } from "@noble/hashes/sha3";

const ETH = 10n ** 18n;
const vendor = "0x2222222222222222222222222222222222222222";
const delegate = "5".repeat(40);
const signer = new LocalKeySigner(keccak_256(new TextEncoder().encode("broadcast test key")));
const HASH = `0x${"ab".repeat(32)}`;

async function setup(opts: { codes: () => string; broadcast: (raw: string) => Promise<string>; dailyNative?: string }) {
  const customers = new CustomerStore();
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, {
    policyId: "p", programAllowlist: ["evm:native"], destinationAllowlist: [vendor],
    maxAmountPerTransaction: { native: String(ETH), "evm:gas": "1000000000000000" }, maxAmountPerDay: { native: opts.dailyNative ?? String(3n * ETH), "evm:gas": "10000000000000000" }, allowedChainIds: [1]
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const lookups: boolean[] = [];
  const app = createServer(new Map(), buildDemoRegistry(), {
    baseUrl: "http://placeholder", reviewActionSecret: "s", customers, reviewers: new ReviewerStore(), evmSigner: signer,
    evmCodeLookup: async (_c, _a, fresh) => { lookups.push(fresh === true); return opts.codes(); },
    evmBroadcaster: async (_c, raw) => opts.broadcast(raw)
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const send = async (nonce: string, extra: object = { broadcast: true }) => {
    const r = await fetch(`${base}/gate-and-sign-evm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({
      agentId: "a", policyId: "p", ...extra,
      transaction: { chainId: 1, from: signer.address, to: vendor, value: "1", nonce, gasLimit: "21000", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "1000000" }
    }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  return { send, lookups, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test("broadcast: the server sends the transaction, returns the hash and not the signed bytes, and re-reads the code uncached", async () => {
  const sent: string[] = [];
  const t = await setup({ codes: () => "0x", broadcast: async (raw) => { sent.push(raw); return HASH; } });
  try {
    const r = await t.send("0");
    assert.equal(r.status, 200);
    assert.equal(r.body.transactionHash, HASH);
    assert.equal(r.body.signedTransaction, undefined, "the signed bytes stay on the server");
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^0x02/);
    assert.deepEqual(t.lookups, [false, true], "first check may use the cache, the last one before sending may not");
  } finally { await t.close(); }
});

test("broadcast: a destination delegated after the first check is not sent, and the budget is returned", async () => {
  let calls = 0;
  let delegatedNow = false;
  let sentCount = 0;
  // The daily cap is exactly one send of 1 wei, so a leaked reservation would block the second attempt.
  const t = await setup({ dailyNative: "1", codes: () => (++calls === 2 || delegatedNow ? `0xef0100${delegate}` : "0x"), broadcast: async () => { sentCount++; return HASH; } });
  try {
    const r = await t.send("0");
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "DESTINATION_CHANGED");
    assert.match(JSON.stringify(r.body.reasons), /delegated \(EIP-7702\)/);
    assert.equal(sentCount, 0, "nothing reached the network");
    const again = await t.send("0");
    assert.equal(again.status, 200, "the reservation came back, so the same 1 wei fits again");
    assert.equal(sentCount, 1);
  } finally { await t.close(); }
});

test("broadcast: a node failure keeps the budget spent, because the outcome is unknown", async () => {
  const t = await setup({ codes: () => "0x", broadcast: async () => { throw new Error("timeout"); } });
  try {
    const r = await t.send("0");
    assert.equal(r.status, 502);
    assert.equal(r.body.error, "EVM_BROADCAST_FAILED");
  } finally { await t.close(); }
});

test("broadcast: a server without a broadcaster refuses broadcast:true, and without the flag still returns signed bytes", async () => {
  const customers = new CustomerStore();
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, { policyId: "p", programAllowlist: ["evm:native"], destinationAllowlist: [vendor], maxAmountPerTransaction: { native: String(ETH), "evm:gas": "1000000000000000" }, maxAmountPerDay: { native: String(3n * ETH), "evm:gas": "10000000000000000" }, allowedChainIds: [1] });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const app = createServer(new Map(), buildDemoRegistry(), { baseUrl: "http://placeholder", reviewActionSecret: "s", customers, reviewers: new ReviewerStore(), evmSigner: signer });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const post = async (extra: object) => (await fetch(`${base}/gate-and-sign-evm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ agentId: "a", policyId: "p", ...extra, transaction: { chainId: 1, from: signer.address, to: vendor, value: "1", nonce: "0", gasLimit: "21000", maxFeePerGas: "1000000000", maxPriorityFeePerGas: "1000000" } }) }));
    assert.equal((await post({ broadcast: true })).status, 503);
    const plain = await post({});
    assert.equal(plain.status, 200);
    assert.match(((await plain.json()) as any).signedTransaction, /^0x02/);
  } finally { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); }
});

test("rpc broadcaster and fresh lookup: parse node replies, never retry, and a fresh read skips the cache", async () => {
  let reply: () => Response = () => Response.json({ jsonrpc: "2.0", id: 1, result: HASH });
  let calls = 0;
  const fetchImpl = (async (_u: string, init: RequestInit) => { calls++; assert.equal(JSON.parse(String(init.body)).method === "eth_sendRawTransaction" || JSON.parse(String(init.body)).method === "eth_getCode", true); return reply(); }) as unknown as typeof fetch;
  const send = rpcBroadcaster({ 1: "http://rpc.invalid" }, fetchImpl);
  assert.equal(await send(1, "0x02"), HASH);
  await assert.rejects(send(5, "0x02"), /No RPC URL/);
  reply = () => new Response("x", { status: 500 });
  await assert.rejects(send(1, "0x02"), /HTTP 500/);
  reply = () => Response.json({ error: { message: "nonce too low" } });
  await assert.rejects(send(1, "0x02"), /nonce too low/);
  reply = () => Response.json({ result: "0x12" });
  await assert.rejects(send(1, "0x02"), /did not accept/);
  assert.equal(calls, 4, "one call per attempt, no retries");

  calls = 0;
  reply = () => Response.json({ result: "0x" });
  const lookup = rpcCodeLookup({ 1: "http://rpc.invalid" }, { fetchImpl, ttlMs: 60_000 });
  await lookup(1, vendor); await lookup(1, vendor);
  assert.equal(calls, 1);
  await lookup(1, vendor, true);
  assert.equal(calls, 2, "a fresh read goes to the node even when cached");
});
