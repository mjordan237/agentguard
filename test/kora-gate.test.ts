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

function buildTransferTransaction(fromPubkey: PublicKey, toPubkey: PublicKey, lamports: number): string {
  const transfer = SystemProgram.transfer({ fromPubkey, toPubkey, lamports });
  const message = new TransactionMessage({
    payerKey: fromPubkey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [transfer]
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
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
      calls += 1;

      if (options.failNextCall) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", error: { code: -32000, message: "signer unavailable" } }));
        return;
      }

      if (rpc.method === "signTransaction") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: rpc.id,
            jsonrpc: "2.0",
            result: { signed_transaction: `${rpc.params.transaction}.SIGNED`, signer_pubkey: options.signerPubkey }
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

test("gate-and-sign submits ALLOWed transactions to Kora and never calls Kora for NEEDS_REVIEW", async () => {
  const fakeSignerPubkey = Keypair.generate().publicKey.toBase58();
  const { server: fakeKora, getCallCount } = createFakeKoraServer({ signerPubkey: fakeSignerPubkey });
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
    const allowTx = buildTransferTransaction(agentWallet.publicKey, approvedVendor.publicKey, 100_000_000);
    const allowResult = await postJson(`${baseUrl}/gate-and-sign`, { agentId: "agent-1", policyId: "demo", transactionBase64: allowTx });

    assert.equal(allowResult.status, 200);
    assert.equal(allowResult.body.decision, "ALLOW");
    assert.ok(allowResult.body.kora, "expected a kora signing result on ALLOW");
    assert.equal(allowResult.body.kora.signer_pubkey, fakeSignerPubkey);
    assert.equal(allowResult.body.kora.signed_transaction, `${allowTx}.SIGNED`);
    assert.equal(getCallCount(), 1, "Kora should have been called exactly once for the ALLOWed transaction");

    const reviewTx = buildTransferTransaction(agentWallet.publicKey, unapprovedVendor.publicKey, 50_000_000);
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

test("gate-and-sign returns KORA_SIGNING_FAILED, not a false ALLOW, when Kora itself errors", async () => {
  const { server: fakeKora } = createFakeKoraServer({ signerPubkey: "unused", failNextCall: true });
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
    const tx = buildTransferTransaction(agentWallet.publicKey, approvedVendor.publicKey, 100_000_000);
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
    const tx = buildTransferTransaction(agentWallet.publicKey, approvedVendor.publicKey, 100_000_000);
    const result = await postJson(`${baseUrl}/gate-and-sign`, { agentId: "agent-1", policyId: "demo", transactionBase64: tx });

    assert.equal(result.status, 503);
    assert.equal(result.body.error, "KORA_NOT_CONFIGURED");
  } finally {
    await appHandle.close();
  }
});
