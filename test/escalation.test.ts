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

function buildAdversarialTransaction(): string {
  const agentWallet = Keypair.generate();
  const vendor = Keypair.generate();
  const attackerProgram = Keypair.generate();
  const transfer = SystemProgram.transfer({ fromPubkey: agentWallet.publicKey, toPubkey: vendor.publicKey, lamports: 250_000_000 });
  const hijack = SystemProgram.assign({ accountPubkey: agentWallet.publicKey, programId: attackerProgram.publicKey });
  const message = new TransactionMessage({
    payerKey: agentWallet.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [transfer, hijack]
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("NEEDS_REVIEW escalates to Slack and can be approved through the review page", async () => {
  // Fake Slack: just records the last webhook payload it received.
  let receivedSlackPayload: any = null;
  const fakeSlack = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      receivedSlackPayload = JSON.parse(raw);
      res.writeHead(200);
      res.end("ok");
    });
  });
  const slackHandle = await listen(fakeSlack);

  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder", // overwritten below once we know our own port
    slackWebhookUrl: `http://localhost:${slackHandle.port}`
  });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  try {
    const evaluateResult = await postJson(`${baseUrl}/evaluate`, {
      agentId: "demo-agent",
      policyId: "demo",
      transactionBase64: buildAdversarialTransaction()
    });

    assert.equal(evaluateResult.status, 200);
    assert.equal(evaluateResult.body.decision, "NEEDS_REVIEW");
    assert.ok(evaluateResult.body.reviewId, "expected a reviewId in the response");
    assert.ok(evaluateResult.body.reviewUrl, "expected a reviewUrl in the response");

    // Give the fire-and-forget Slack POST a moment to land.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(receivedSlackPayload, "expected the fake Slack webhook to receive a POST");
    assert.equal(receivedSlackPayload.blocks[0].text.text, "Transaction needs review");
    const bodyText = JSON.stringify(receivedSlackPayload);
    assert.ok(bodyText.includes("demo-agent"), "Slack payload should mention the agent id");
    assert.ok(bodyText.includes("assign") === false, "unresolved instruction has no name, so 'assign' should not literally appear");

    const reviewId = evaluateResult.body.reviewId;

    const beforeApproval = await fetch(`${baseUrl}/review/${reviewId}`);
    const beforeHtml = await beforeApproval.text();
    assert.equal(beforeApproval.status, 200);
    assert.ok(beforeHtml.includes("PENDING"));
    assert.ok(beforeHtml.includes("Approve"));

    const approve = await fetch(`${baseUrl}/review/${reviewId}/approve`, { method: "POST", redirect: "manual" });
    assert.equal(approve.status, 302);

    const afterApproval = await fetch(`${baseUrl}/review/${reviewId}`);
    const afterHtml = await afterApproval.text();
    assert.ok(afterHtml.includes("APPROVED"));
    assert.ok(!afterHtml.includes("<button"), "resolved review should no longer show approve/deny buttons");
  } finally {
    await appHandle.close();
    await slackHandle.close();
  }
});

test("an agentId containing Slack markup is escaped before it reaches the Slack payload", async () => {
  let receivedSlackPayload: any = null;
  const fakeSlack = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      receivedSlackPayload = JSON.parse(raw);
      res.writeHead(200);
      res.end("ok");
    });
  });
  const slackHandle = await listen(fakeSlack);

  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder",
    slackWebhookUrl: `http://localhost:${slackHandle.port}`
  });
  const appServer = http.createServer(app);
  const appHandle = await listen(appServer);
  const baseUrl = `http://localhost:${appHandle.port}`;

  // A caller-controlled agentId shaped to inject a channel-wide ping and
  // a fake link if it reached Slack's mrkdwn renderer unescaped.
  const maliciousAgentId = "<!channel> urgent & <https://evil.example/phish|click here>";

  try {
    await postJson(`${baseUrl}/evaluate`, {
      agentId: maliciousAgentId,
      policyId: "demo",
      transactionBase64: buildAdversarialTransaction()
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(receivedSlackPayload, "expected the fake Slack webhook to receive a POST");

    const agentField = receivedSlackPayload.blocks[1].text.text;
    assert.ok(!agentField.includes("<!channel>"), "raw <!channel> markup must not reach Slack");
    assert.ok(!agentField.includes("<https://evil.example/phish|click here>"), "raw link markup must not reach Slack");
    assert.ok(agentField.includes("&lt;!channel&gt;"), "expected the escaped form of the malicious agentId");
  } finally {
    await appHandle.close();
    await slackHandle.close();
  }
});
