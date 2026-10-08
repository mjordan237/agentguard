import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createServer } from "../src/api/server.js";
import { EvaluationLog } from "../src/observability/evaluation-log.js";
import { DailySpendTracker } from "../src/policy/daily-spend-tracker.js";
import { openSqliteDatabase } from "../src/storage/sqlite.js";
import { buildDemoPolicy, buildDemoRegistry } from "../demo/policy.js";

function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((done) => server.close(() => done())) });
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
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function startPersistentServer(persistencePath: string) {
  const policies = new Map([["demo", buildDemoPolicy()]]);
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder",
    persistencePath,
    reviewActionSecret: "restart-test-secret"
  });
  const handle = await listen(http.createServer(app));
  return { baseUrl: `http://localhost:${handle.port}`, close: handle.close };
}

async function startSpendServer(persistencePath: string, approvedVendor: string) {
  const policies = new Map([["demo", buildDemoPolicy([approvedVendor], "1000", "100")]]);
  const app = createServer(policies, buildDemoRegistry(), {
    baseUrl: "http://placeholder",
    persistencePath,
    reviewActionSecret: "restart-test-secret"
  });
  const handle = await listen(http.createServer(app));
  return { baseUrl: `http://localhost:${handle.port}`, close: handle.close };
}

function runWriter(persistencePath: string, agentId: string, count: number): Promise<void> {
  const workerPath = fileURLToPath(new URL("./persistence-writer.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, persistencePath, agentId, String(count)], {
      stdio: ["ignore", "ignore", "pipe"]
    });
    let standardError = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      standardError += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`persistence writer ${agentId} exited with ${code}: ${standardError}`));
    });
  });
}

test("pending reviews and evaluation history survive a server restart when persistence is configured", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentguard-persistence-"));
  const persistencePath = join(directory, "agentguard.sqlite");
  const first = await startPersistentServer(persistencePath);

  try {
    const result = await postJson(`${first.baseUrl}/evaluate`, {
      agentId: "restart-agent",
      policyId: "demo",
      transactionBase64: buildAdversarialTransaction()
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.decision, "NEEDS_REVIEW");
    assert.equal(typeof result.body.reviewId, "string");
    assert.equal(typeof result.body.logEntryId, "string");

    await first.close();
    const second = await startPersistentServer(persistencePath);
    try {
      const review = await fetch(`${second.baseUrl}/review/${result.body.reviewId}`);
      const reviewHtml = await review.text();
      assert.equal(review.status, 200);
      assert.ok(reviewHtml.includes("PENDING"));

      const history = await fetch(`${second.baseUrl}/agents/restart-agent/history`);
      const historyBody = await history.json();
      assert.equal(history.status, 200);
      assert.deepEqual(historyBody.summary, { total: 1, allow: 0, needsReview: 1 });
      assert.equal(historyBody.entries[0].id, result.body.logEntryId);

      const approval = await fetch(`${second.baseUrl}/review/${result.body.reviewId}/approve`, {
        method: "POST",
        redirect: "manual",
        headers: { "x-review-action-secret": "restart-test-secret" }
      });
      assert.equal(approval.status, 302);

      const resolved = await fetch(`${second.baseUrl}/review/${result.body.reviewId}`);
      assert.ok((await resolved.text()).includes("APPROVED"));
    } finally {
      await second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("two independent Node processes preserve all concurrent evaluation-log writes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentguard-persistence-"));
  const persistencePath = join(directory, "agentguard.sqlite");

  try {
    // Establish the schema before writers begin. The assertion below tests
    // concurrent inserts, rather than turning table creation into the subject
    // of the concurrency test.
    new EvaluationLog({ persistencePath });
    await Promise.all([
      runWriter(persistencePath, "writer-a", 25),
      runWriter(persistencePath, "writer-b", 25)
    ]);

    const reader = new EvaluationLog({ persistencePath });
    const entries = reader.query({});
    assert.equal(entries.length, 50);
    assert.equal(entries.filter((entry) => entry.agentId === "writer-a").length, 25);
    assert.equal(entries.filter((entry) => entry.agentId === "writer-b").length, 25);
    assert.ok(entries.every((entry) => entry.evaluation.decoded.instructions[0]?.amount === 42n));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("daily spend remains enforced after a server restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentguard-persistence-"));
  const persistencePath = join(directory, "agentguard.sqlite");
  const agent = Keypair.generate();
  const vendor = Keypair.generate();
  const transfer = buildTransferTransaction(agent.publicKey, vendor.publicKey, 60);
  const first = await startSpendServer(persistencePath, vendor.publicKey.toBase58());

  try {
    const allowed = await postJson(`${first.baseUrl}/evaluate`, {
      agentId: "spend-restart-agent",
      policyId: "demo",
      transactionBase64: transfer
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.decision, "ALLOW");
    await first.close();

    const second = await startSpendServer(persistencePath, vendor.publicKey.toBase58());
    try {
      const overDailyLimit = await postJson(`${second.baseUrl}/evaluate`, {
        agentId: "spend-restart-agent",
        policyId: "demo",
        transactionBase64: transfer
      });
      assert.equal(overDailyLimit.status, 200);
      assert.equal(overDailyLimit.body.decision, "NEEDS_REVIEW");
      assert.match(overDailyLimit.body.reasons.join("\n"), /today's total native spend to 120/);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("daily spend totals sum as bigint and ignore prior UTC dates", () => {
  const directory = mkdtempSync(join(tmpdir(), "agentguard-persistence-"));
  const persistencePath = join(directory, "agentguard.sqlite");

  try {
    const first = new DailySpendTracker({ persistencePath });
    first.record("policy-a", { native: 9n, token: 2n });
    first.record("policy-a", { native: 11n });
    assert.deepEqual(first.spentToday("policy-a"), { native: 20n, token: 2n });

    const second = new DailySpendTracker({ persistencePath });
    second.record("policy-a", { native: 3n });
    assert.deepEqual(second.spentToday("policy-a"), { native: 23n, token: 2n });

    const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().slice(0, 10);
    openSqliteDatabase(persistencePath).prepare(`
      INSERT INTO daily_spend (policy_id, asset, spend_date, amount)
      VALUES (?, ?, ?, ?)
    `).run("policy-a", "expired-day", yesterday, "999999999999999999999999999999999999");
    assert.deepEqual(new DailySpendTracker({ persistencePath }).spentToday("policy-a"), { native: 23n, token: 2n });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
