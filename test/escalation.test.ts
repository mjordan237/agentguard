import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { createServer } from "../src/api/server.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";
import { readReview } from "./review-detail-helper.js";

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

async function startReviewApp(options: { reviewActionSecret?: string; reviewExpiryMs?: number; rateLimit?: { maxRequests: number; windowMs: number } } = {}) {
  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder",
    ...options
  });
  const server = http.createServer(app);
  const handle = await listen(server);
  return { baseUrl: `http://localhost:${handle.port}`, close: handle.close };
}

async function createPendingReview(baseUrl: string): Promise<string> {
  const result = await postJson(`${baseUrl}/evaluate`, {
    agentId: "demo-agent",
    policyId: "demo",
    transactionBase64: buildAdversarialTransaction()
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.decision, "NEEDS_REVIEW");
  assert.equal(typeof result.body.reviewId, "string");
  return result.body.reviewId;
}

async function postReviewAction(
  url: string,
  secret: string | undefined,
  format: "header" | "form" = "header"
): Promise<Response> {
  if (format === "form") {
    return fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(secret === undefined ? {} : { secret }).toString()
    });
  }
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: secret === undefined ? {} : { "x-review-action-secret": secret }
  });
}

function postReviewActionFromIp(url: string, secret: string, address: string): Promise<number> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: address,
        port: target.port,
        path: target.pathname,
        method: "POST",
        localAddress: address,
        headers: { "x-review-action-secret": secret }
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      }
    );
    request.once("error", reject);
    request.end();
  });
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
    slackWebhookUrl: `http://localhost:${slackHandle.port}`,
    reviewActionSecret: "test-review-secret"
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
    assert.equal(beforeApproval.headers.get("x-frame-options"), "DENY");
    assert.match(beforeApproval.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(beforeApproval.headers.get("referrer-policy"), "no-referrer");
    assert.equal(beforeApproval.headers.get("cache-control"), "no-store");
    // The link opens a sign-in page; the review itself is read only with a credential.
    assert.ok(!beforeHtml.includes(reviewId) && !beforeHtml.includes("demo-agent"), "no review data before sign-in");
    const before = await readReview(baseUrl, reviewId, { secret: "test-review-secret" });
    assert.equal(before.status, "PENDING");
    assert.equal(before.actionable, true);

    const approve = await fetch(`${baseUrl}/review/${reviewId}/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "x-review-action-secret": "test-review-secret" }
    });
    assert.equal(approve.status, 302);

    const after = await readReview(baseUrl, reviewId, { secret: "test-review-secret" });
    assert.equal(after.status, "APPROVED");
    assert.ok(after.createdAt && after.expiresAt);
    assert.ok(after.resolvedAt, "resolved review should show when it was acted on");
    assert.equal(after.actionable, false, "resolved review should no longer offer approve/deny");
  } finally {
    await appHandle.close();
    await slackHandle.close();
  }
});

test("a correct review action secret approves a pending review and records the resolution time", async () => {
  const app = await startReviewApp({ reviewActionSecret: "review-secret" });
  try {
    const reviewId = await createPendingReview(app.baseUrl);
    const approval = await postReviewAction(`${app.baseUrl}/review/${reviewId}/approve`, "review-secret");
    assert.equal(approval.status, 302);

    const view = await readReview(app.baseUrl, reviewId, { secret: "review-secret" });
    assert.equal(view.status, "APPROVED");
    assert.ok(view.resolvedAt);
  } finally {
    await app.close();
  }
});

test("a correct secret submitted through the review form denies a pending review", async () => {
  const app = await startReviewApp({ reviewActionSecret: "review-secret" });
  try {
    const reviewId = await createPendingReview(app.baseUrl);
    const denial = await postReviewAction(`${app.baseUrl}/review/${reviewId}/deny`, "review-secret", "form");
    assert.equal(denial.status, 302);

    const view = await readReview(app.baseUrl, reviewId, { secret: "review-secret" });
    assert.equal(view.status, "DENIED");
    assert.ok(view.resolvedAt);
  } finally {
    await app.close();
  }
});

test("a missing review action secret cannot approve a review", async () => {
  const app = await startReviewApp({ reviewActionSecret: "review-secret" });
  try {
    const reviewId = await createPendingReview(app.baseUrl);
    const approval = await postReviewAction(`${app.baseUrl}/review/${reviewId}/approve`, undefined);
    assert.equal(approval.status, 401);

    assert.equal((await readReview(app.baseUrl, reviewId, { secret: "review-secret" })).status, "PENDING");
  } finally {
    await app.close();
  }
});

test("a wrong review action secret cannot deny a review", async () => {
  const app = await startReviewApp({ reviewActionSecret: "review-secret" });
  try {
    const reviewId = await createPendingReview(app.baseUrl);
    const denial = await postReviewAction(`${app.baseUrl}/review/${reviewId}/deny`, "wrong-secret");
    assert.equal(denial.status, 401);

    assert.equal((await readReview(app.baseUrl, reviewId, { secret: "review-secret" })).status, "PENDING");
  } finally {
    await app.close();
  }
});

test("review action attempts are rate-limited per IP without blocking a different IP", async () => {
  const app = await startReviewApp({ reviewActionSecret: "review-secret", rateLimit: { maxRequests: 2, windowMs: 60_000 } });
  try {
    const reviewId = await createPendingReview(app.baseUrl);
    const actionUrl = `${app.baseUrl}/review/${reviewId}/approve`;

    assert.equal(await postReviewActionFromIp(actionUrl, "wrong-secret", "127.0.0.1"), 401);
    assert.equal(await postReviewActionFromIp(actionUrl, "wrong-secret", "127.0.0.1"), 401);
    assert.equal(await postReviewActionFromIp(actionUrl, "wrong-secret", "127.0.0.1"), 429);

    // This must remain readable; only POST approval/denial paths consume the
    // separate brute-force budget.
    assert.equal((await fetch(`${app.baseUrl}/review/${reviewId}`)).status, 200);
    assert.equal(await postReviewActionFromIp(actionUrl, "wrong-secret", "::1"), 401);
  } finally {
    await app.close();
  }
});

test("review mutations fail closed when no action secret is configured", async () => {
  const app = await startReviewApp();
  try {
    const reviewId = await createPendingReview(app.baseUrl);
    const approval = await postReviewAction(`${app.baseUrl}/review/${reviewId}/approve`, "any-secret");
    assert.equal(approval.status, 503);

    // Nobody can sign in, so the review is not readable through the review pages either; the agent's own
    // status endpoint (open mode here) still shows it untouched.
    const blocked = await fetch(`${app.baseUrl}/operator/api/reviews/${reviewId}`, { headers: { "x-review-action-secret": "any-secret" } });
    assert.equal(blocked.status, 503);
    assert.match(((await blocked.json()) as { message: string }).message, /switched off/);
    assert.equal(((await (await fetch(`${app.baseUrl}/reviews/${reviewId}`)).json()) as { status: string }).status, "PENDING");
    assert.ok(!(await (await fetch(`${app.baseUrl}/review/${reviewId}`)).text()).includes('name="secret"'));
  } finally {
    await app.close();
  }
});

test("an expired review cannot be approved even with the correct secret", async () => {
  const app = await startReviewApp({ reviewActionSecret: "review-secret", reviewExpiryMs: 1 });
  try {
    const reviewId = await createPendingReview(app.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const approval = await postReviewAction(`${app.baseUrl}/review/${reviewId}/approve`, "review-secret");
    assert.equal(approval.status, 410);

    assert.equal((await readReview(app.baseUrl, reviewId, { secret: "review-secret" })).status, "EXPIRED");
  } finally {
    await app.close();
  }
});

test("an expired review cannot be denied even with the correct secret", async () => {
  const app = await startReviewApp({ reviewActionSecret: "review-secret", reviewExpiryMs: 1 });
  try {
    const reviewId = await createPendingReview(app.baseUrl);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const denial = await postReviewAction(`${app.baseUrl}/review/${reviewId}/deny`, "review-secret");
    assert.equal(denial.status, 410);

    assert.equal((await readReview(app.baseUrl, reviewId, { secret: "review-secret" })).status, "EXPIRED");
  } finally {
    await app.close();
  }
});

test("a resolved review cannot be flipped by a later action", async () => {
  const app = await startReviewApp({ reviewActionSecret: "review-secret" });
  try {
    const reviewId = await createPendingReview(app.baseUrl);
    assert.equal((await postReviewAction(`${app.baseUrl}/review/${reviewId}/approve`, "review-secret")).status, 302);
    assert.equal((await postReviewAction(`${app.baseUrl}/review/${reviewId}/deny`, "review-secret")).status, 302);

    const view = await readReview(app.baseUrl, reviewId, { secret: "review-secret" });
    assert.equal(view.status, "APPROVED");
  } finally {
    await app.close();
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
