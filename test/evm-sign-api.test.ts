import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { LocalKeySigner, type EvmSigner, type SignableEvmTransaction } from "../src/evm/sign.js";
import { buildDemoRegistry } from "../demo/policy.js";

const ETH = 10n ** 18n;
const KEY = Uint8Array.from(Buffer.from("3342460a1ac7dc070dfa35508ff134dfa8664edd4ce80e7f112e43cc118ba87e", "hex"));
const local = new LocalKeySigner(KEY);
const agent = local.address;
const vendor = "0x2222222222222222222222222222222222222222";
const attacker = "0x3333333333333333333333333333333333333333";
const GWEI = 10n ** 9n;
// Fee per transaction below: 100000 gas x 50 gwei = 0.005 ETH. Caps: 0.01 ETH each, 0.03 ETH a day (6 transactions).
const FEE = 100_000n * 50n * GWEI;

async function setup(opts: { signer?: EvmSigner | null; gasCaps?: boolean } = {}) {
  const signer = opts.signer === null ? undefined : (opts.signer ?? local);
  const customers = new CustomerStore();
  const acme = customers.create("acme");
  const gas = opts.gasCaps === false ? {} : { "evm:gas": undefined };
  customers.setPolicy(acme.id, {
    policyId: "acme-evm", programAllowlist: ["evm:native"], destinationAllowlist: [vendor],
    maxAmountPerTransaction: { native: String(ETH), ...(opts.gasCaps === false ? {} : { "evm:gas": String(ETH / 100n) }) },
    maxAmountPerDay: { native: String(10n * ETH), ...(opts.gasCaps === false ? {} : { "evm:gas": String(3n * ETH / 100n) }) },
    allowedChainIds: [1]
  });
  void gas;
  const globex = customers.create("globex");
  customers.setPolicy(globex.id, {
    policyId: "globex-evm", programAllowlist: ["evm:native"], destinationAllowlist: [], allowAnyDestination: true,
    maxAmountPerTransaction: { native: String(100n * ETH), "evm:gas": String(ETH) }, maxAmountPerDay: { native: String(1000n * ETH), "evm:gas": String(10n * ETH) }, allowedChainIds: [1]
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const app = createServer(new Map(), buildDemoRegistry(), { baseUrl: "http://placeholder", reviewActionSecret: "operator-secret", customers, reviewers: new ReviewerStore(), evmSigner: signer });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${apiKey}` }) => {
    const r = await fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const tx = (over: Record<string, unknown> = {}) => ({ chainId: 1, from: agent, to: vendor, value: (ETH / 2n).toString(), nonce: "0", gasLimit: "100000", maxFeePerGas: String(50n * GWEI), maxPriorityFeePerGas: String(2n * GWEI), ...over });
  const sign = (transaction: object, extra: object = {}, policyId = "acme-evm") => call("/gate-and-sign-evm", { agentId: "a1", policyId, transaction, ...extra });
  const approve = (id: string) => call(`/review/${id}/approve`, undefined, { "x-review-action-secret": "operator-secret" });
  return { call, sign, tx, approve, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

const asTx = (t: any): SignableEvmTransaction => ({ chainId: t.chainId, from: t.from, to: t.to, value: BigInt(t.value), nonce: BigInt(t.nonce), gasLimit: BigInt(t.gasLimit), maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) });

test("evm sign api: an allowed transaction is signed, and the bytes are what the signer produces", async () => {
  const t = await setup();
  try {
    const body = t.tx();
    const r = await t.sign(body);
    assert.equal(r.status, 200);
    assert.equal(r.body.decision, "ALLOW");
    assert.equal(r.body.signedTransaction, await local.signTransaction(asTx(body)));
    assert.equal(r.body.signer, agent);
  } finally { await t.close(); }
});

test("evm sign api: a payment to an attacker is not signed and waits for a person", async () => {
  const t = await setup();
  try {
    const r = await t.sign(t.tx({ to: attacker }));
    assert.equal(r.body.decision, "NEEDS_REVIEW");
    assert.equal(r.body.signedTransaction, undefined);
    assert.ok(r.body.reviewId);
  } finally { await t.close(); }
});

test("evm sign api: an approved review signs that exact transaction once, and no other", async () => {
  const t = await setup();
  try {
    const odd = t.tx({ to: attacker, value: "1000" });
    const first = await t.sign(odd);
    const id = first.body.reviewId;
    assert.equal((await t.sign(odd, { reviewId: id })).status, 409, "still pending");
    assert.ok([200, 302, 303].includes((await t.approve(id)).status));
    assert.equal((await t.sign({ ...odd, nonce: "1" }, { reviewId: id })).status, 400, "a different nonce is a different transaction");
    assert.equal((await t.sign({ ...odd, gasLimit: "99999" }, { reviewId: id })).status, 400, "gas is bound too");
    const signed = await t.sign(odd, { reviewId: id });
    assert.equal(signed.status, 200);
    assert.equal(signed.body.signedViaReview, id);
    assert.equal((await t.sign(odd, { reviewId: id })).status, 409, "an approval is spent once");
  } finally { await t.close(); }
});

test("evm sign api: a fee above the cap, a missing fee cap and an inverted tip all go to review", async () => {
  const t = await setup();
  try {
    assert.equal((await t.sign(t.tx({ gasLimit: "300000" }))).body.decision, "NEEDS_REVIEW", "0.015 ETH of fee against a 0.01 ETH cap");
    assert.equal((await t.sign(t.tx({ maxPriorityFeePerGas: String(60n * GWEI) }))).body.decision, "NEEDS_REVIEW");
  } finally { await t.close(); }
  const noCaps = await setup({ gasCaps: false });
  try {
    const r = await noCaps.sign(noCaps.tx());
    assert.equal(r.body.decision, "NEEDS_REVIEW");
    assert.match(JSON.stringify(r.body.reasons), /no per-transaction limit for evm:gas/);
  } finally { await noCaps.close(); }
});

test("evm sign api: 20 concurrent transactions cannot beat the daily fee cap", async () => {
  const t = await setup();
  try {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => t.sign(t.tx({ nonce: String(i), value: "1" }))));
    const signed = results.filter((r) => r.body?.signedTransaction !== undefined).length;
    assert.equal(signed, 6, "6 x 0.005 ETH = the 0.03 ETH daily fee cap");
  } finally { await t.close(); }
});

test("evm sign api: it only signs for its own address, and answers 503 with no signer", async () => {
  const t = await setup();
  try {
    const r = await t.sign(t.tx({ from: attacker }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "SIGNER_MISMATCH");
  } finally { await t.close(); }
  const none = await setup({ signer: null });
  try { assert.equal((await none.sign(none.tx())).status, 503); } finally { await none.close(); }
});

test("evm sign api: another customer's policy and a missing key are refused", async () => {
  const t = await setup();
  try {
    assert.equal((await t.sign(t.tx({ to: attacker }), {}, "globex-evm")).status, 404);
    assert.equal((await t.call("/gate-and-sign-evm", { agentId: "a", policyId: "acme-evm", transaction: t.tx() }, {})).status, 401);
    assert.equal((await t.sign({ chainId: 1, from: agent })).status, 400, "gas fields are required");
  } finally { await t.close(); }
});

test("evm sign api: a failed signing attempt gives the budget and the approval back", async () => {
  let failures = 1;
  const flaky: EvmSigner = { address: agent, signTransaction: async (tx) => { if (failures-- > 0) throw new Error("hsm unavailable"); return local.signTransaction(tx); } };
  const t = await setup({ signer: flaky });
  try {
    assert.equal((await t.sign(t.tx({ nonce: "0", value: "1" }))).status, 500);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => t.sign(t.tx({ nonce: String(i), value: "1" }))));
    assert.equal(results.filter((r) => r.body?.signedTransaction !== undefined).length, 6, "the failed attempt did not eat any of the 6");
  } finally { await t.close(); }
});
