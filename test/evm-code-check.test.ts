import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { codeCheckReasons, rpcCodeLookup, type CodeLookup } from "../src/evm/code-check.js";
import { decodeEvmTransaction } from "../src/evm/decode.js";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";
import { parsePolicy } from "../src/policy/validate.js";

const agent = "0x1111111111111111111111111111111111111111";
const vendor = "0x2222222222222222222222222222222222222222";
const stranger = "0x4444444444444444444444444444444444444444";
const delegate = "0x5555555555555555555555555555555555555555";
const DELEGATED = `0xef0100${delegate.slice(2)}`;
const ETH = 10n ** 18n;

const policy = parsePolicy({
  policyId: "p", programAllowlist: ["evm:native"], destinationAllowlist: [vendor, stranger],
  maxAmountPerTransaction: { native: String(ETH) }, maxAmountPerDay: { native: String(3n * ETH) }, allowedChainIds: [1]
});
const open = parsePolicy({ ...policy, allowAnyDestination: true, destinationAllowlist: [] });
const summaryTo = (to: string) => decodeEvmTransaction({ chainId: 1, from: agent, to, value: 1n });
const codes = (m: Record<string, string | undefined>): CodeLookup => async (_c, a) => (a in m ? m[a] : "0x");

test("code check: a plain account passes, even when nothing else is known about it", async () => {
  assert.deepEqual(await codeCheckReasons(summaryTo(vendor), policy, 1, codes({})), []);
});

test("code check: an allowlisted account that has been delegated (EIP-7702) goes to review", async () => {
  const reasons = await codeCheckReasons(summaryTo(vendor), policy, 1, codes({ [vendor]: DELEGATED }));
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /delegated \(EIP-7702\) to 0x5555/);
});

test("code check: a delegate the customer trusts passes, any other delegate does not", async () => {
  const trusting = parsePolicy({ ...policy, trustedDelegates: [delegate.toUpperCase().replace("0X", "0x")] });
  assert.deepEqual(await codeCheckReasons(summaryTo(vendor), trusting, 1, codes({ [vendor]: DELEGATED })), []);
  const other = `0xef0100${"66".repeat(20)}`;
  assert.match((await codeCheckReasons(summaryTo(vendor), trusting, 1, codes({ [vendor]: other })))[0], /not in the policy's trustedDelegates/);
  assert.match((await codeCheckReasons(summaryTo(vendor), policy, 1, codes({ [vendor]: DELEGATED })))[0], /trustedDelegates/);
});

test("code check: an unlisted contract is reviewed, a listed one is not", async () => {
  const contract = "0x6080604052";
  assert.match((await codeCheckReasons(summaryTo(stranger), open, 1, codes({ [stranger]: contract })))[0], /not in the policy's allowlists/);
  assert.deepEqual(await codeCheckReasons(summaryTo(vendor), policy, 1, codes({ [vendor]: contract })), [], "the customer listed it, so it is known");
});

test("code check: unreadable code and an unknown chain fail closed", async () => {
  assert.match((await codeCheckReasons(summaryTo(vendor), policy, 1, codes({ [vendor]: undefined })))[0], /could not be read/);
  assert.match((await codeCheckReasons(summaryTo(vendor), policy, 1, async () => { throw new Error("down"); }))[0], /could not be read/);
  assert.match((await codeCheckReasons(summaryTo(vendor), policy, 1, codes({ [vendor]: "0xzz" })))[0], /could not be read/);
  assert.match((await codeCheckReasons(summaryTo(vendor), policy, undefined, codes({})))[0], /chain is not known/);
});

test("code check: a raw_dump has no destination to look up", async () => {
  let calls = 0;
  const summary = decodeEvmTransaction({ chainId: 1, from: agent, to: vendor, data: "0xdeadbeef" });
  assert.deepEqual(await codeCheckReasons(summary, policy, 1, async () => { calls++; return "0x"; }), []);
  assert.equal(calls, 0);
});

test("rpc lookup: reads eth_getCode, caches, and gives undefined on errors", async () => {
  let calls = 0;
  let reply: () => Response = () => Response.json({ jsonrpc: "2.0", id: 1, result: DELEGATED });
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.method, "eth_getCode");
    assert.deepEqual(body.params, [vendor, "latest"]);
    return reply();
  }) as unknown as typeof fetch;
  const lookup = rpcCodeLookup({ 1: "http://rpc.invalid" }, { fetchImpl, ttlMs: 60_000 });
  assert.equal(await lookup(1, vendor), DELEGATED);
  assert.equal(await lookup(1, vendor.toUpperCase().replace("0X", "0x")), DELEGATED);
  assert.equal(calls, 1, "the second lookup came from the cache");
  assert.equal(await lookup(5, vendor), undefined, "no URL for that chain");
  const fresh = rpcCodeLookup({ 1: "http://rpc.invalid" }, { fetchImpl });
  reply = () => new Response("nope", { status: 429 });
  assert.equal(await fresh(1, vendor), undefined, "an HTTP error is not 'no code'");
  reply = () => Response.json({ error: { code: -32000 } });
  assert.equal(await fresh(1, vendor), undefined);
  reply = () => Response.json({ result: "garbage" });
  assert.equal(await fresh(1, vendor), undefined);
});

test("evm api: a delegated recipient is held for review, a plain one is allowed", async () => {
  const customers = new CustomerStore();
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, {
    policyId: "acme-evm", programAllowlist: ["evm:native"], destinationAllowlist: [vendor, stranger],
    maxAmountPerTransaction: { native: String(ETH), "evm:gas": "1000000000000000" }, maxAmountPerDay: { native: String(3n * ETH), "evm:gas": "10000000000000000" }, allowedChainIds: [1]
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const state: Record<string, string> = { [vendor]: "0x", [stranger]: DELEGATED };
  const app = createServer(new Map(), buildDemoRegistry(), {
    baseUrl: "http://placeholder", reviewActionSecret: "s", customers, reviewers: new ReviewerStore(),
    evmCodeLookup: async (_c, a) => state[a] ?? "0x"
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const call = async (to: string) => {
      const r = await fetch(`${base}/evaluate-evm`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ agentId: "a", policyId: "acme-evm", transaction: { chainId: 1, from: agent, to, value: "1" } }) });
      return (await r.json()) as any;
    };
    assert.equal((await call(vendor)).decision, "ALLOW");
    const held = await call(stranger);
    assert.equal(held.decision, "NEEDS_REVIEW");
    assert.match(JSON.stringify(held.reasons), /delegated \(EIP-7702\)/);
    state[vendor] = DELEGATED; // delegated after it was allowlisted
    assert.equal((await call(vendor)).decision, "NEEDS_REVIEW");
  } finally {
    await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); });
  }
});
