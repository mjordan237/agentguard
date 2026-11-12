import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import { createServer, type ServerConfig } from "../src/api/server.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";
import { readReview, decisionOf } from "./review-detail-helper.js";
import { APP_SCRIPT, APP_SHELL_HTML } from "../src/escalation/operator-queue-page.js";

function listen(server: http.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ port, close: () => new Promise((res) => { server.close(() => res()); server.closeAllConnections(); }) });
    });
  });
}

function buildAdversarialTransaction(): string {
  const agentWallet = Keypair.generate();
  const vendor = Keypair.generate();
  const attackerProgram = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: agentWallet.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      SystemProgram.transfer({ fromPubkey: agentWallet.publicKey, toPubkey: vendor.publicKey, lamports: 250_000_000 }),
      SystemProgram.assign({ accountPubkey: agentWallet.publicKey, programId: attackerProgram.publicKey })
    ]
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

async function startApp(options: Partial<ServerConfig>) {
  const app = createServer(new Map([["demo", buildDemoPolicy()]]), buildDemoRegistry(), {
    baseUrl: "http://placeholder",
    ...options
  });
  const handle = await listen(http.createServer(app));
  return { baseUrl: `http://localhost:${handle.port}`, close: handle.close };
}

async function createReview(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "demo-agent", policyId: "demo", transactionBase64: buildAdversarialTransaction() })
  });
  const body = (await response.json()) as { decision: string; reviewId: string };
  assert.equal(body.decision, "NEEDS_REVIEW");
  return body.reviewId;
}

function act(baseUrl: string, id: string, action: "approve" | "deny", credential: string | undefined, via: "header" | "form" = "header") {
  if (via === "form") {
    return fetch(`${baseUrl}/review/${id}/${action}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(credential === undefined ? {} : { token: credential }).toString()
    });
  }
  return fetch(`${baseUrl}/review/${id}/${action}`, {
    method: "POST",
    redirect: "manual",
    headers: credential === undefined ? {} : { "x-reviewer-token": credential }
  });
}

async function pageText(baseUrl: string, id: string): Promise<string> {
  return (await fetch(`${baseUrl}/review/${id}`)).text();
}

/** The status and resolver the server recorded, from the agent's own status endpoint (open mode here, so no key). */
async function recorded(baseUrl: string, id: string): Promise<{ status: string; resolvedBy?: string }> {
  return (await (await fetch(`${baseUrl}/reviews/${id}`)).json()) as { status: string; resolvedBy?: string };
}

test("ReviewerStore issues a token once, authenticates it, and never stores it in plaintext", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-reviewers-"));
  const path = join(dir, "db.sqlite");
  try {
    const store = new ReviewerStore({ persistencePath: path });
    const { reviewer, token } = store.create("Alice Example");
    assert.match(token, /^agr_[A-Za-z0-9_-]{43}$/);
    assert.equal(store.authenticate(token)?.id, reviewer.id);
    assert.equal(store.authenticate(token + "x"), undefined);
    assert.equal(store.authenticate("agr_" + "A".repeat(43)), undefined);
    assert.equal(store.authenticate(undefined), undefined);
    assert.equal(store.authenticate("not-a-token"), undefined);

    // Survives a new connection, and the raw token appears nowhere in the database files.
    assert.equal(new ReviewerStore({ persistencePath: path }).authenticate(token)?.name, "Alice Example");
    for (const file of readdirSync(dir)) {
      assert.ok(!readFileSync(join(dir, file)).includes(token), `token found in plaintext in ${file}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ReviewerStore revocation stops a token working, validates names, and reports unknown ids", () => {
  const store = new ReviewerStore();
  const { reviewer, token } = store.create("Bob");
  assert.equal(store.hasActiveReviewers(), true);
  assert.equal(store.revoke(reviewer.id), true);
  assert.equal(store.revoke(reviewer.id), false, "second revoke is a no-op");
  assert.equal(store.revoke("no-such-id"), false);
  assert.equal(store.authenticate(token), undefined);
  assert.equal(store.hasActiveReviewers(), false);
  assert.throws(() => store.create("   "), /must not be empty/);
  assert.throws(() => store.create("x".repeat(81)), /at most 80/);
});

test("a registered reviewer can approve, and the review records who did it", async () => {
  const reviewers = new ReviewerStore();
  const { token } = reviewers.create("Alice Example");
  const app = await startApp({ reviewers });
  try {
    const id = await createReview(app.baseUrl);
    assert.equal(await pageText(app.baseUrl, id), APP_SHELL_HTML, "the link opens the sign-in page");
    const response = await act(app.baseUrl, id, "approve", token);
    assert.equal(response.status, 302);
    assert.match(decisionOf(await readReview(app.baseUrl, id, { token })), /^Approved by Alice Example at /);
    assert.deepEqual(await recorded(app.baseUrl, id), { ...(await recorded(app.baseUrl, id)), status: "APPROVED", resolvedBy: "Alice Example" });
  } finally {
    await app.close();
  }
});

test("form submissions with a reviewer token work too", async () => {
  const reviewers = new ReviewerStore();
  const { token } = reviewers.create("Carol");
  const app = await startApp({ reviewers });
  try {
    const id = await createReview(app.baseUrl);
    assert.equal((await act(app.baseUrl, id, "deny", token, "form")).status, 302);
    assert.match(decisionOf(await readReview(app.baseUrl, id, { token })), /^Denied by Carol at /);
  } finally {
    await app.close();
  }
});

test("wrong, missing, and revoked tokens are rejected and leave the review pending", async () => {
  const reviewers = new ReviewerStore();
  const { reviewer, token } = reviewers.create("Dave");
  const app = await startApp({ reviewers });
  try {
    const id = await createReview(app.baseUrl);
    assert.equal((await act(app.baseUrl, id, "approve", "agr_wrong")).status, 401);
    assert.equal((await act(app.baseUrl, id, "approve", undefined)).status, 401);
    reviewers.revoke(reviewer.id);
    // With the only reviewer revoked and no shared secret, actions are disabled outright.
    assert.equal((await act(app.baseUrl, id, "approve", token)).status, 503);
    assert.equal((await recorded(app.baseUrl, id)).status, "PENDING");
  } finally {
    await app.close();
  }
});

test("the first resolver keeps the attribution when a second reviewer acts afterwards", async () => {
  const reviewers = new ReviewerStore();
  const first = reviewers.create("First Reviewer");
  const second = reviewers.create("Second Reviewer");
  const app = await startApp({ reviewers });
  try {
    const id = await createReview(app.baseUrl);
    await act(app.baseUrl, id, "approve", first.token);
    await act(app.baseUrl, id, "deny", second.token);
    const view = await readReview(app.baseUrl, id, { token: second.token });
    assert.match(decisionOf(view), /^Approved by First Reviewer at /);
    assert.equal(view.status, "APPROVED");
    assert.deepEqual(view.resolvedBy, { kind: "reviewer", name: "First Reviewer" });
  } finally {
    await app.close();
  }
});

test("attribution survives a server restart and a revoked reviewer's past decisions keep their name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-auth-restart-"));
  const persistencePath = join(dir, "db.sqlite");
  try {
    const reviewers = new ReviewerStore({ persistencePath });
    const { reviewer, token } = reviewers.create("Erin");
    let app = await startApp({ persistencePath, reviewers });
    const id = await createReview(app.baseUrl);
    await act(app.baseUrl, id, "approve", token);
    await app.close();

    reviewers.revoke(reviewer.id);
    app = await startApp({ persistencePath });
    try {
      // Erin's token is revoked and no other credential exists, so read the recorded attribution directly.
      assert.deepEqual([(await recorded(app.baseUrl, id)).status, (await recorded(app.baseUrl, id)).resolvedBy], ["APPROVED", "Erin"]);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a reviewer added to the database file while the server runs is accepted without a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentguard-auth-live-"));
  const persistencePath = join(dir, "db.sqlite");
  try {
    const app = await startApp({ persistencePath });
    try {
      const id = await createReview(app.baseUrl);
      assert.equal((await act(app.baseUrl, id, "approve", "agr_whatever")).status, 503);
      const { token } = new ReviewerStore({ persistencePath }).create("Frank"); // what scripts/reviewers.mjs does
      assert.equal((await act(app.baseUrl, id, "approve", token)).status, 302);
      assert.match(decisionOf(await readReview(app.baseUrl, id, { token })), /^Approved by Frank at /);
    } finally {
      await app.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shared secret still works by default but is recorded as not identifying anyone", async () => {
  const app = await startApp({ reviewActionSecret: "legacy-secret" });
  try {
    const id = await createReview(app.baseUrl);
    const response = await fetch(`${app.baseUrl}/review/${id}/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "x-review-action-secret": "legacy-secret" }
    });
    assert.equal(response.status, 302);
    assert.match(decisionOf(await readReview(app.baseUrl, id, { secret: "legacy-secret" })), /^Approved using the shared secret \(no individual identified\) at /);
    assert.equal((await recorded(app.baseUrl, id)).resolvedBy, "shared secret");
  } finally {
    await app.close();
  }
});

test("requireReviewers makes the shared secret useless while reviewer tokens still work", async () => {
  const reviewers = new ReviewerStore();
  const { token } = reviewers.create("Grace");
  const app = await startApp({ reviewers, reviewActionSecret: "legacy-secret", requireReviewers: true });
  try {
    const id = await createReview(app.baseUrl);
    const withSecret = await fetch(`${app.baseUrl}/review/${id}/approve`, {
      method: "POST",
      redirect: "manual",
      headers: { "x-review-action-secret": "legacy-secret" }
    });
    assert.equal(withSecret.status, 401);
    assert.equal((await act(app.baseUrl, id, "approve", token)).status, 302);
  } finally {
    await app.close();
  }
});

test("with no reviewers and no shared secret, approve and deny fail closed", async () => {
  const app = await startApp({});
  try {
    const id = await createReview(app.baseUrl);
    assert.equal((await act(app.baseUrl, id, "approve", "agr_anything")).status, 503);
    const read = await fetch(`${app.baseUrl}/operator/api/reviews/${id}`, { headers: { "x-reviewer-token": "agr_anything" } });
    assert.equal(read.status, 503, "and the review cannot be read through the review pages either");
    assert.equal((await recorded(app.baseUrl, id)).status, "PENDING");
  } finally {
    await app.close();
  }
});

test("a reviewer name containing markup reaches the review page as data, never as markup", async () => {
  const reviewers = new ReviewerStore();
  const { token } = reviewers.create("<script>alert(1)</script>");
  const app = await startApp({ reviewers });
  try {
    const id = await createReview(app.baseUrl);
    await act(app.baseUrl, id, "approve", token);
    assert.ok(!(await pageText(app.baseUrl, id)).includes("alert(1)"), "nothing of it before sign-in");
    const view = await readReview(app.baseUrl, id, { token });
    assert.deepEqual(view.resolvedBy, { kind: "reviewer", name: "<script>alert(1)</script>" }, "kept verbatim as JSON data");
    for (const sink of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) assert.ok(!APP_SCRIPT.includes(sink), `the page places it as text (${sink})`);
  } finally {
    await app.close();
  }
});
