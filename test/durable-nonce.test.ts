import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer } from "../src/api/server.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";

const listen = (server: http.Server) => new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
  server.listen(0, () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) })));

/** A payment that uses a durable nonce: the nonce's stored value stands where a recent blockhash would go. */
function durablePayment(options: { feePayer: PublicKey; agent: Keypair; to: PublicKey; nonceAuthority?: PublicKey; advanceSecond?: boolean; withoutPayment?: boolean }) {
  const nonceAccount = Keypair.generate().publicKey;
  const advance = SystemProgram.nonceAdvance({ noncePubkey: nonceAccount, authorizedPubkey: options.nonceAuthority ?? options.agent.publicKey });
  const payment = SystemProgram.transfer({ fromPubkey: options.agent.publicKey, toPubkey: options.to, lamports: 100_000_000 });
  const instructions = options.withoutPayment ? [advance] : options.advanceSecond ? [payment, advance] : [advance, payment];
  const nonceValue = Keypair.generate().publicKey.toBase58();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: options.feePayer, recentBlockhash: nonceValue, instructions }).compileToV0Message());
  tx.sign([options.agent]);
  return Buffer.from(tx.serialize()).toString("base64");
}

const decode = (transactionBase64: string) => parseAndDecodeTransaction(transactionBase64, buildDemoRegistry());

test("a nonce advance is decoded, and a durable payment within policy is ALLOWed", async () => {
  const agent = Keypair.generate(), vendor = Keypair.generate().publicKey;
  const decoded = await decode(durablePayment({ feePayer: Keypair.generate().publicKey, agent, to: vendor }));
  assert.equal(decoded.instructions[0]!.instructionName, "advanceNonceAccount");
  assert.equal(decoded.instructions[0]!.mode, "interpolated");
  assert.equal(decoded.instructions[0]!.fields.authority, agent.publicKey.toBase58());
  const result = evaluatePolicy(decoded, buildDemoPolicy([vendor.toBase58()]));
  assert.equal(result.decision, "ALLOW", result.reasons.join("\n"));
});

test("a nonce advance anywhere but first, or on its own, goes to review", async () => {
  const agent = Keypair.generate(), vendor = Keypair.generate().publicKey, feePayer = Keypair.generate().publicKey;
  const second = evaluatePolicy(await decode(durablePayment({ feePayer, agent, to: vendor, advanceSecond: true })), buildDemoPolicy([vendor.toBase58()]));
  assert.equal(second.decision, "NEEDS_REVIEW");
  assert.ok(second.reasons.some((reason) => /only belongs first/.test(reason)), second.reasons.join("\n"));
  const alone = evaluatePolicy(await decode(durablePayment({ feePayer, agent, to: vendor, withoutPayment: true })), buildDemoPolicy([vendor.toBase58()]));
  assert.equal(alone.decision, "NEEDS_REVIEW");
  assert.ok(alone.reasons.some((reason) => /nonce advance and no other instruction/.test(reason)), alone.reasons.join("\n"));
});

test("a nonce advance with the wrong sysvar or account count is not decoded", async () => {
  const agent = Keypair.generate(), feePayer = Keypair.generate().publicKey;
  const forged = new TransactionInstruction({
    programId: SystemProgram.programId,
    data: Buffer.from([4, 0, 0, 0]),
    keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }, { pubkey: agent.publicKey, isSigner: true, isWritable: false }]
  });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: feePayer, recentBlockhash: PublicKey.default.toBase58(), instructions: [forged] }).compileToV0Message());
  const decoded = await decode(Buffer.from(tx.serialize()).toString("base64"));
  assert.equal(decoded.instructions[0]!.mode, "raw_dump");
  assert.match(String(decoded.instructions[0]!.fields.reason), /RecentBlockhashes sysvar/);
});

/** A stand-in Kora that signs whatever it is sent and counts the calls. */
async function fakeKora(signer: PublicKey) {
  let calls = 0;
  const handle = await listen(http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const rpc = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      if (rpc.method === "getPayerSigner") return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signer_address: signer.toBase58(), payment_address: signer.toBase58() } }));
      calls += 1;
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signature: `sig-${calls}`, signed_transaction: "x", signer_pubkey: signer.toBase58() } }));
    });
  }));
  return { ...handle, calls: () => calls };
}

test("a durable payment sent to review can be approved and signed with the same bytes", async () => {
  const relayer = Keypair.generate().publicKey, agent = Keypair.generate(), vendor = Keypair.generate().publicKey;
  const kora = await fakeKora(relayer);
  const secret = "r".repeat(40);
  // The vendor is not allowlisted, so the payment needs a person.
  const app = createServer(new Map([["demo", buildDemoPolicy([])]]), buildDemoRegistry(), { baseUrl: "http://placeholder", reviewActionSecret: secret, koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${kora.port}` }) } });
  const server = await listen(http.createServer(app));
  const base = `http://localhost:${server.port}`;
  const post = async (body: unknown) => { const r = await fetch(`${base}/gate-and-sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; };
  try {
    const transactionBase64 = durablePayment({ feePayer: relayer, agent, to: vendor });
    const first = await post({ agentId: "a", policyId: "demo", transactionBase64 });
    assert.equal(first.body.decision, "NEEDS_REVIEW");
    assert.ok(first.body.reasons.every((reason: string) => !/raw_dump/.test(reason)), "the nonce advance itself is understood, only the destination is in question");
    const approve = await fetch(`${base}/review/${first.body.reviewId}/approve`, { method: "POST", headers: { "x-review-action-secret": secret }, redirect: "manual" });
    assert.ok(approve.status < 400);
    const second = await post({ agentId: "a", policyId: "demo", transactionBase64, reviewId: first.body.reviewId });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.kora.signature, "sig-1");
    assert.equal(kora.calls(), 1);
  } finally {
    await server.close();
    await kora.close();
  }
});

test("a durable payment whose nonce authority is the relayer is refused before Kora signs", async () => {
  const relayer = Keypair.generate().publicKey, agent = Keypair.generate(), vendor = Keypair.generate().publicKey;
  const kora = await fakeKora(relayer);
  const app = createServer(new Map([["demo", buildDemoPolicy([vendor.toBase58()])]]), buildDemoRegistry(), { baseUrl: "http://placeholder", koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${kora.port}` }) } });
  const server = await listen(http.createServer(app));
  try {
    const transactionBase64 = durablePayment({ feePayer: relayer, agent, to: vendor, nonceAuthority: relayer });
    const r = await fetch(`http://localhost:${server.port}/gate-and-sign`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "a", policyId: "demo", transactionBase64 }) });
    const body = await r.json() as any;
    assert.equal(body.error, "KORA_FEE_PAYER_IN_INSTRUCTION", JSON.stringify(body));
    assert.equal(kora.calls(), 0);
  } finally {
    await server.close();
    await kora.close();
  }
});

test("a review opened for a transaction without a durable nonce warns that it will expire; a durable one does not", async () => {
  const relayer = Keypair.generate().publicKey, agent = Keypair.generate(), vendor = Keypair.generate().publicKey;
  const app = createServer(new Map([["demo", buildDemoPolicy([])]]), buildDemoRegistry(), { baseUrl: "http://placeholder" });
  const server = await listen(http.createServer(app));
  const evaluate = async (transactionBase64: string) => (await (await fetch(`http://localhost:${server.port}/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "a", policyId: "demo", transactionBase64 }) })).json()) as any;
  try {
    const plain = new VersionedTransaction(new TransactionMessage({ payerKey: relayer, recentBlockhash: PublicKey.default.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: vendor, lamports: 1 })] }).compileToV0Message());
    const warned = await evaluate(Buffer.from(plain.serialize()).toString("base64"));
    assert.equal(warned.decision, "NEEDS_REVIEW");
    assert.match(warned.warnings?.[0] ?? "", /durable nonce/);
    const durable = await evaluate(durablePayment({ feePayer: relayer, agent, to: vendor }));
    assert.equal(durable.decision, "NEEDS_REVIEW");
    assert.equal(durable.warnings, undefined);
  } finally {
    await server.close();
  }
});
