import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer } from "../src/api/server.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";

function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

/**
 * Builds a transaction the way a real Kora signer actually expects:
 * `feePayer` (Kora's own configured signer) as the fee payer, with the
 * agent as a separate instruction-level signer authorizing the transfer.
 * Confirmed against real, live Kora instances on devnet and mainnet --
 * see scripts/kora-live-test/. The old version of this test built the
 * transaction with the agent as fee payer, which doesn't match what a
 * real Kora signer expects.
 */
function buildTransferTransaction(feePayer: PublicKey, agentWallet: Keypair, toPubkey: PublicKey, lamports: number): string {
  const transfer = SystemProgram.transfer({ fromPubkey: agentWallet.publicKey, toPubkey, lamports });
  const message = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [transfer]
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([agentWallet]);
  return Buffer.from(tx.serialize()).toString("base64");
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/**
 * A real local JSON-RPC 2.0 server speaking Kora's actual wire format
 * (method/params/id in, result/error out over POST) -- not a mock of the
 * KoraClient class, an actual server the real client talks to over HTTP.
 */
function createFakeKoraServer(options: { signerPubkey: string; failNextCall?: boolean }) {
  let lastRequest: { method: string; params: unknown } | null = null;
  let calls = 0;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const rpc = JSON.parse(raw);
      lastRequest = { method: rpc.method, params: rpc.params };

      if (rpc.method === "getPayerSigner") {
        // Not counted in calls -- the gate always needs this to validate
        // the fee payer, regardless of whether it ultimately signs.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: rpc.id,
            jsonrpc: "2.0",
            result: { signer_address: options.signerPubkey, payment_address: options.signerPubkey }
          })
        );
        return;
      }

      calls += 1;

      if (options.failNextCall) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", error: { code: -32000, message: "signer unavailable" } }));
        return;
      }

      if (rpc.method === "signAndSendTransaction") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: rpc.id,
            jsonrpc: "2.0",
            result: {
              signature: `fake-signature-${calls}`,
              signed_transaction: `${rpc.params.transaction}.SIGNED`,
              signer_pubkey: options.signerPubkey
            }
          })
        );
        return;
      }

      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", error: { code: -32601, message: "method not found" } }));
    });
  });

  return { server, getLastRequest: () => lastRequest, getCallCount: () => calls };
}

test("gate-and-sign signs and submits ALLOWed transactions through Kora, and never calls Kora for NEEDS_REVIEW", async () => {
  const feePayerKeypair = Keypair.generate();
  const feePayerPubkey = feePayerKeypair.publicKey.toBase58();
  const { server: fakeKora, getCallCount } = createFakeKoraServer({ signerPubkey: feePayerPubkey });
  const koraHandle = await listen(fakeKora);

  const agentWallet = Keypair.generate();
  const approvedVendor = Keypair.generate();
  const unapprovedVendor = Keypair.generate();

  const policies = new Map([["demo", buildDemoPolicy([approvedVendor.publicKey.toBase58()])]]);
  const koraClient = new KoraClient({ rpcUrl: `http://localhost:${koraHandle.port}` });
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder", koraGate: { client: koraClient } });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const allowTx = buildTransferTransaction(feePayerKeypair.publicKey, agentWallet, approvedVendor.publicKey, 100_000_000);
    const allowResult = await postJson(`${baseUrl}/gate-and-sign`, { agentId: "agent-1", policyId: "demo", transactionBase64: allowTx });

    assert.equal(allowResult.status, 200, JSON.stringify(allowResult.body));
    assert.equal(allowResult.body.decision, "ALLOW");
    assert.ok(allowResult.body.kora, "expected a kora signing result on ALLOW");
    assert.equal(allowResult.body.kora.signer_pubkey, feePayerPubkey);
    assert.equal(allowResult.body.kora.signature, "fake-signature-1", "a real signature means it was actually submitted, not just signed");
    assert.equal(getCallCount(), 1, "Kora should have been called exactly once for the ALLOWed transaction");

    const reviewTx = buildTransferTransaction(feePayerKeypair.publicKey, agentWallet, unapprovedVendor.publicKey, 50_000_000);
    const reviewResult = await postJson(`${baseUrl}/gate-and-sign`, { agentId: "agent-1", policyId: "demo", transactionBase64: reviewTx });

    assert.equal(reviewResult.status, 200);
    assert.equal(reviewResult.body.decision, "NEEDS_REVIEW");
    assert.ok(reviewResult.body.reviewId, "NEEDS_REVIEW should still create a review, same as /evaluate");
    assert.ok(!reviewResult.body.kora, "a blocked transaction must never carry a Kora signing result");
    assert.equal(getCallCount(), 1, "Kora must not be called at all for a NEEDS_REVIEW transaction");
  } finally {
    await appHandle.close();
    await koraHandle.close();
  }
});

test("gate-and-sign fails closed with KORA_FEE_PAYER_MISMATCH when the transaction's fee payer isn't Kora's own signer", async () => {
  const realFeePayer = Keypair.generate();
  const { server: fakeKora, getCallCount } = createFakeKoraServer({ signerPubkey: realFeePayer.publicKey.toBase58() });
  const koraHandle = await listen(fakeKora);

  const agentWallet = Keypair.generate();
  const approvedVendor = Keypair.generate();
  const policies = new Map([["demo", buildDemoPolicy([approvedVendor.publicKey.toBase58()])]]);
  const koraClient = new KoraClient({ rpcUrl: `http://localhost:${koraHandle.port}` });
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder", koraGate: { client: koraClient } });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    // Built the old, incorrect way: the agent is its own fee payer,
    // exactly the shape that doesn't match what a real Kora signer
    // expects. This must fail closed with a clear, specific error
    // instead of either silently succeeding or returning a generic
    // Kora-side failure.
    const transfer = SystemProgram.transfer({ fromPubkey: agentWallet.publicKey, toPubkey: approvedVendor.publicKey, lamports: 100_000_000 });
    const message = new TransactionMessage({
      payerKey: agentWallet.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [transfer]
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    tx.sign([agentWallet]);
    const wrongShapeTx = Buffer.from(tx.serialize()).toString("base64");

    const result = await postJson(`${baseUrl}/gate-and-sign`, { agentId: "agent-1", policyId: "demo", transactionBase64: wrongShapeTx });

    assert.equal(result.status, 400, JSON.stringify(result.body));
    assert.equal(result.body.error, "KORA_FEE_PAYER_MISMATCH");
    assert.ok(result.body.message.includes(agentWallet.publicKey.toBase58()), "error should name the wrong fee payer actually found");
    assert.ok(result.body.message.includes(realFeePayer.publicKey.toBase58()), "error should name Kora's real expected signer");
    assert.equal(getCallCount(), 0, "Kora's signing method must never be called when the fee payer is wrong, only getPayerSigner for validation");
  } finally {
    await appHandle.close();
    await koraHandle.close();
  }
});

test("gate-and-sign returns KORA_SIGNING_FAILED, not a false ALLOW, when Kora itself errors", async () => {
  const feePayerKeypair = Keypair.generate();
  const { server: fakeKora } = createFakeKoraServer({ signerPubkey: feePayerKeypair.publicKey.toBase58(), failNextCall: true });
  const koraHandle = await listen(fakeKora);

  const agentWallet = Keypair.generate();
  const approvedVendor = Keypair.generate();
  const policies = new Map([["demo", buildDemoPolicy([approvedVendor.publicKey.toBase58()])]]);
  const koraClient = new KoraClient({ rpcUrl: `http://localhost:${koraHandle.port}` });
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder", koraGate: { client: koraClient } });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const tx = buildTransferTransaction(feePayerKeypair.publicKey, agentWallet, approvedVendor.publicKey, 100_000_000);
    const result = await postJson(`${baseUrl}/gate-and-sign`, { agentId: "agent-1", policyId: "demo", transactionBase64: tx });

    assert.equal(result.status, 502);
    assert.equal(result.body.error, "KORA_SIGNING_FAILED");
  } finally {
    await appHandle.close();
    await koraHandle.close();
  }
});

test("gate-and-sign fails closed with KORA_NOT_CONFIGURED when no Kora client is wired in", async () => {
  const agentWallet = Keypair.generate();
  const approvedVendor = Keypair.generate();
  const policies = new Map([["demo", buildDemoPolicy([approvedVendor.publicKey.toBase58()])]]);
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder" });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const tx = buildTransferTransaction(Keypair.generate().publicKey, agentWallet, approvedVendor.publicKey, 100_000_000);
    const result = await postJson(`${baseUrl}/gate-and-sign`, { agentId: "agent-1", policyId: "demo", transactionBase64: tx });

    assert.equal(result.status, 503);
    assert.equal(result.body.error, "KORA_NOT_CONFIGURED");
  } finally {
    await appHandle.close();
  }
});
