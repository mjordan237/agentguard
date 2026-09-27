import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
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

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
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

test("every /evaluate call is recorded and queryable through the observability log, not just NEEDS_REVIEW ones", async () => {
  const agentWallet = Keypair.generate();
  const approvedVendor = Keypair.generate();
  const unapprovedVendor = Keypair.generate();

  const policies = new Map([["demo", buildDemoPolicy([approvedVendor.publicKey.toBase58()])]]);
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://placeholder" });
  const server = http.createServer(app);
  const { port, close } = await listen(server);
  const baseUrl = `http://localhost:${port}`;

  try {
    const allowResult = await postJson(`${baseUrl}/evaluate`, {
      agentId: "agent-1",
      policyId: "demo",
      transactionBase64: buildTransferTransaction(agentWallet.publicKey, approvedVendor.publicKey, 100_000_000)
    });
    assert.equal(allowResult.status, 200);
    assert.equal(allowResult.body.decision, "ALLOW");
    assert.ok(allowResult.body.logEntryId, "ALLOW response should still carry a logEntryId");

    const reviewResult = await postJson(`${baseUrl}/evaluate`, {
      agentId: "agent-1",
      policyId: "demo",
      transactionBase64: buildTransferTransaction(agentWallet.publicKey, unapprovedVendor.publicKey, 50_000_000)
    });
    assert.equal(reviewResult.status, 200);
    assert.equal(reviewResult.body.decision, "NEEDS_REVIEW");
    assert.ok(reviewResult.body.logEntryId);

    // A second agent's activity must not bleed into agent-1's history.
    await postJson(`${baseUrl}/evaluate`, {
      agentId: "agent-2",
      policyId: "demo",
      transactionBase64: buildTransferTransaction(agentWallet.publicKey, approvedVendor.publicKey, 10_000_000)
    });

    const historyResponse = await fetch(`${baseUrl}/agents/agent-1/history`);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json();

    assert.deepEqual(history.summary, { total: 2, allow: 1, needsReview: 1 });
    assert.equal(history.entries.length, 2);
    // Most recent first: the NEEDS_REVIEW evaluation was submitted second.
    assert.equal(history.entries[0].evaluation.decision, "NEEDS_REVIEW");
    assert.equal(history.entries[1].evaluation.decision, "ALLOW");
    assert.ok(history.entries.every((entry: any) => entry.agentId === "agent-1"));

    const filteredResponse = await fetch(`${baseUrl}/agents/agent-1/history?decision=ALLOW`);
    const filtered = await filteredResponse.json();
    assert.equal(filtered.entries.length, 1);
    assert.equal(filtered.entries[0].evaluation.decision, "ALLOW");

    const oneEntryResponse = await fetch(`${baseUrl}/transactions/${allowResult.body.logEntryId}`);
    assert.equal(oneEntryResponse.status, 200);
    const oneEntry = await oneEntryResponse.json();
    assert.equal(oneEntry.id, allowResult.body.logEntryId);
    assert.equal(oneEntry.agentId, "agent-1");

    const missingResponse = await fetch(`${baseUrl}/transactions/does-not-exist`);
    assert.equal(missingResponse.status, 404);
  } finally {
    await close();
  }
});
