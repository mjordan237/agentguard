import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";
import { registerStandardPrograms, TOKEN_PROGRAM } from "../src/agent-integration/standard-programs.js";

// Threat model: an attacker holds the agent's AgentGuard API key AND the agent's own signing key.
// They can submit any transaction, with any agentId, as fast as they like. They do not hold a reviewer token,
// the review-action secret, the operator's database or the Kora fee-payer key.

const SOL = 1_000_000_000;
const wasSigned = (r: { status: number; body: any }) => r.status === 200 && r.body?.kora !== undefined;
const listen = (server: http.Server) => new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
  server.listen(0, () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) })));

function fakeKora(signer: string, state: { calls: number }) {
  return http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rpc = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      if (rpc.method === "getPayerSigner") return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signer_address: signer, payment_address: signer } }));
      state.calls += 1;
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signature: `sig-${state.calls}`, signed_transaction: "x", signer_pubkey: signer } }));
    });
  });
}

function txOf(feePayer: PublicKey, instructions: TransactionInstruction[]): string {
  const message = new TransactionMessage({ payerKey: feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return Buffer.from(tx.serialize()).toString("base64");
}

async function setup() {
  const feePayer = Keypair.generate();
  const vendor = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  const state = { calls: 0 };
  const kora = await listen(fakeKora(feePayer.publicKey.toBase58(), state));
  const customers = new CustomerStore();
  const reviewers = new ReviewerStore();
  const acme = customers.create("acme");
  customers.setPolicy(acme.id, {
    policyId: "acme-pay", programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [vendor.toBase58()],
    maxAmountPerTransaction: { native: String(1 * SOL) }, maxAmountPerDay: { native: String(3 * SOL) }
  });
  const other = customers.create("globex");
  customers.setPolicy(other.id, {
    policyId: "globex-pay", programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [], allowAnyDestination: true,
    maxAmountPerTransaction: { native: String(100 * SOL) }, maxAmountPerDay: { native: String(1000 * SOL) }
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const keyId = customers.listKeys(acme.id)[0].id;
  const registry = buildDemoRegistry();
  registerStandardPrograms(registry);
  const app = createServer(new Map(), registry, {
    baseUrl: "http://placeholder", reviewActionSecret: "operator-secret", customers, reviewers,
    koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${kora.port}` }) }
  });
  const server = await listen(http.createServer(app));
  const baseUrl = `http://localhost:${server.port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${baseUrl}${path}`, { method, redirect: "manual", headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const auth = { authorization: `Bearer ${apiKey}` };
  const sign = (tx: string, n = 0, policyId = "acme-pay", headers = auth) => call("POST", "/gate-and-sign", { agentId: `agent-${n}`, policyId, transactionBase64: tx }, headers);
  const pay = (to: PublicKey, lamports: number) => txOf(feePayer.publicKey, [SystemProgram.transfer({ fromPubkey: agent, toPubkey: to, lamports })]);
  return { feePayer: feePayer.publicKey, vendor, agent, state, customers, acme, keyId, apiKey, call, sign, pay, auth, close: async () => { await server.close(); await kora.close(); } };
}

test("compromised agent: paying the attacker's own address is never signed", async () => {
  const t = await setup();
  try {
    const r = await t.sign(t.pay(Keypair.generate().publicKey, 10_000_000));
    assert.equal(r.body.decision, "NEEDS_REVIEW");
    assert.equal(t.state.calls, 0);
  } finally { await t.close(); }
});

test("compromised agent: the daily cap bounds total loss even when every payment is to an allowed vendor", async () => {
  const t = await setup();
  try {
    let signed = 0;
    for (let i = 0; i < 20; i++) if (wasSigned(await t.sign(t.pay(t.vendor, SOL / 2), i))) signed += 1;
    assert.equal(signed, 6, "6 x 0.5 SOL = the 3 SOL daily cap, nothing more");
    assert.equal(t.state.calls, 6);
  } finally { await t.close(); }
});

test("compromised agent: 40 simultaneous requests under different agent ids cannot beat the daily cap", async () => {
  const t = await setup();
  try {
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => t.sign(t.pay(t.vendor, SOL / 2), i)));
    const signed = results.filter(wasSigned).length;
    assert.ok(signed <= 6, `signed ${signed}`);
    assert.equal(t.state.calls, signed);
  } finally { await t.close(); }
});

test("compromised agent: splitting one big payment across instructions hits the per-transaction cap", async () => {
  const t = await setup();
  try {
    const four = txOf(t.feePayer, Array.from({ length: 4 }, () => SystemProgram.transfer({ fromPubkey: t.agent, toPubkey: t.vendor, lamports: 300_000_000 })));
    const r = await t.sign(four);
    assert.equal(wasSigned(r), false);
    assert.equal(t.state.calls, 0);
  } finally { await t.close(); }
});

test("compromised agent: SPL Token Approve / SetAuthority (hand the funds to someone else) is not auto-allowed", async () => {
  const t = await setup();
  try {
    const attacker = Keypair.generate().publicKey;
    const source = Keypair.generate().publicKey;
    const approve = new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM), keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: attacker, isSigner: false, isWritable: false }, { pubkey: t.agent, isSigner: true, isWritable: false }],
      data: Buffer.concat([Buffer.from([4]), Buffer.alloc(8, 255)])
    });
    const setAuthority = new TransactionInstruction({
      programId: new PublicKey(TOKEN_PROGRAM), keys: [{ pubkey: source, isSigner: false, isWritable: true }, { pubkey: t.agent, isSigner: true, isWritable: false }],
      data: Buffer.concat([Buffer.from([6, 2, 1]), attacker.toBuffer()])
    });
    for (const ix of [approve, setAuthority]) {
      const r = await t.sign(txOf(t.feePayer, [ix]));
      assert.equal(wasSigned(r), false, JSON.stringify(r.body));
      assert.notEqual(r.body.decision, "ALLOW");
    }
    assert.equal(t.state.calls, 0);
  } finally { await t.close(); }
});

test("compromised agent: the API key cannot approve its own review or change the policy", async () => {
  const t = await setup();
  try {
    const first = await t.sign(t.pay(Keypair.generate().publicKey, 1000));
    const id = first.body.reviewId;
    for (const headers of [t.auth as Record<string, string>, { "x-reviewer-token": t.apiKey }, { "x-review-action-secret": t.apiKey }, { "x-reviewer-token": "guess" }]) {
      const r = await t.call("POST", `/review/${id}/approve`, undefined, headers);
      assert.ok([401, 403, 404].includes(r.status), `approve got ${r.status} with ${Object.keys(headers)}`);
    }
    const attempt = await t.sign(t.pay(Keypair.generate().publicKey, 1000));
    assert.equal(t.state.calls, 0);
    assert.equal(attempt.body.decision, "NEEDS_REVIEW");
    for (const [m, p] of [["PUT", "/policies/acme-pay"], ["POST", "/policies"], ["PUT", "/policy"], ["POST", "/customers"], ["POST", "/reviewers"], ["POST", "/keys"]] as const) {
      const r = await t.call(m, p, { policyId: "acme-pay", maxAmountPerTransaction: { native: "999999999999" } }, t.auth);
      assert.ok([404, 405].includes(r.status), `${m} ${p} -> ${r.status}`);
    }
    const stillCapped = await t.sign(t.pay(t.vendor, 2 * SOL));
    assert.equal(wasSigned(stillCapped), false);
  } finally { await t.close(); }
});

test("compromised agent: using another customer's policy id does not work", async () => {
  const t = await setup();
  try {
    const r = await t.sign(t.pay(Keypair.generate().publicKey, 50 * SOL), 0, "globex-pay");
    assert.equal(wasSigned(r), false);
    assert.equal(t.state.calls, 0);
  } finally { await t.close(); }
});

test("revoking the key stops the attacker immediately, at once", async () => {
  const t = await setup();
  try {
    assert.equal(wasSigned(await t.sign(t.pay(t.vendor, SOL / 2))), true);
    t.customers.revokeKey(t.keyId);
    const r = await t.sign(t.pay(t.vendor, SOL / 2));
    assert.ok([401, 403].includes(r.status), `after revoke: ${r.status}`);
    assert.equal(t.state.calls, 1);
  } finally { await t.close(); }
});

test("a policy with an empty destination allowlist fails closed unless allowAnyDestination is set", async () => {
  const t = await setup();
  try {
    t.customers.setPolicy(t.acme.id, {
      policyId: "acme-pay", programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [],
      maxAmountPerTransaction: { native: String(1 * SOL) }, maxAmountPerDay: { native: String(3 * SOL) }
    });
    const r = await t.sign(t.pay(Keypair.generate().publicKey, 10_000_000));
    assert.equal(wasSigned(r), false);
    assert.equal(r.body.decision, "NEEDS_REVIEW");
    assert.equal(t.state.calls, 0);
    t.customers.setPolicy(t.acme.id, {
      policyId: "acme-pay", programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [], allowAnyDestination: true,
      maxAmountPerTransaction: { native: String(1 * SOL) }, maxAmountPerDay: { native: String(3 * SOL) }
    });
    assert.equal(wasSigned(await t.sign(t.pay(Keypair.generate().publicKey, 10_000_000))), true);
  } finally { await t.close(); }
});
