import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createServer, type ServerConfig } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";
import { readReview, decisionOf } from "./review-detail-helper.js";

// An Assign instruction next to a transfer: the demo registry cannot decode it, so it escalates.
function escalatingTx(): string {
  const payer = Keypair.generate();
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1000 }),
      SystemProgram.assign({ accountPubkey: payer.publicKey, programId: Keypair.generate().publicKey })
    ]
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString("base64");
}

const policyFor = (policyId: string) => ({
  policyId, programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [], allowAnyDestination: true,
  maxAmountPerTransaction: { native: "1000000000" }, maxAmountPerDay: { native: "5000000000" }
});

async function startApp(options: Partial<ServerConfig>) {
  const app = createServer(new Map([["demo", buildDemoPolicy()]]), buildDemoRegistry(), { baseUrl: "http://placeholder", ...options });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://localhost:${port}`, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

function setup() {
  const customers = new CustomerStore();
  const reviewers = new ReviewerStore();
  const mk = (name: string) => {
    const customer = customers.create(name);
    customers.setPolicy(customer.id, policyFor(`${name}-pay`));
    return { customer, apiKey: customers.issueKey(customer.id).apiKey, policyId: `${name}-pay` };
  };
  return { customers, reviewers, acme: mk("acme"), globex: mk("globex") };
}

async function escalate(baseUrl: string, who: { apiKey: string; policyId: string }): Promise<string> {
  const response = await fetch(`${baseUrl}/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${who.apiKey}` },
    body: JSON.stringify({ agentId: "a", policyId: who.policyId, transactionBase64: escalatingTx() })
  });
  const body = (await response.json()) as { decision: string; reviewId: string };
  assert.equal(body.decision, "NEEDS_REVIEW");
  return body.reviewId;
}

const act = (baseUrl: string, id: string, token: string, action: "approve" | "deny" = "approve") =>
  fetch(`${baseUrl}/review/${id}/${action}`, { method: "POST", redirect: "manual", headers: { "x-reviewer-token": token } });
/** The decision as a signed-in reviewer with `token` sees it. */
const decision = async (baseUrl: string, id: string, token: string) => { const view = await readReview(baseUrl, id, { token }); return `${view.status} ${decisionOf(view)}`; };

test("a customer's reviewer can act on that customer's reviews only", async () => {
  const { customers, reviewers, acme, globex } = setup();
  const acmeReviewer = reviewers.create("Alice at Acme", acme.customer.id);
  const operator = reviewers.create("Operator");
  const app = await startApp({ customers, reviewers });
  try {
    const acmeReview = await escalate(app.baseUrl, acme);
    const globexReview = await escalate(app.baseUrl, globex);
    assert.equal((await act(app.baseUrl, globexReview, acmeReviewer.token)).status, 404, "other customer's review looks missing");
    assert.match(await decision(app.baseUrl, globexReview, operator.token), /^PENDING /, "and was left untouched");
    assert.equal((await fetch(`${app.baseUrl}/operator/api/reviews/${globexReview}`, { headers: { "x-reviewer-token": acmeReviewer.token } })).status, 404, "nor readable by them");
    assert.equal((await act(app.baseUrl, acmeReview, acmeReviewer.token)).status, 302);
    assert.match(await decision(app.baseUrl, acmeReview, acmeReviewer.token), /^APPROVED Approved by Alice at Acme at /);
  } finally { await app.close(); }
});

test("an operator reviewer (no customer) can act on any customer's review", async () => {
  const { customers, reviewers, acme, globex } = setup();
  const operator = reviewers.create("Operator");
  const app = await startApp({ customers, reviewers });
  try {
    for (const who of [acme, globex]) {
      const id = await escalate(app.baseUrl, who);
      assert.equal((await act(app.baseUrl, id, operator.token, "deny")).status, 302);
      assert.match(await decision(app.baseUrl, id, operator.token), /^DENIED Denied by Operator at /);
    }
  } finally { await app.close(); }
});

test("a customer-scoped reviewer cannot act on open-mode reviews that belong to no customer", async () => {
  const customers = new CustomerStore();
  const reviewers = new ReviewerStore();
  const scoped = reviewers.create("Scoped", customers.create("Acme").id);
  const app = await startApp({ customers, reviewers });
  try {
    // Open-mode evaluation is impossible once a customer exists, so create the review directly.
    const unscopedApp = await startApp({ reviewers });
    const id = await (async () => {
      const response = await fetch(`${unscopedApp.baseUrl}/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "a", policyId: "demo", transactionBase64: escalatingTx() }) });
      return ((await response.json()) as { reviewId: string }).reviewId;
    })();
    assert.equal((await act(unscopedApp.baseUrl, id, scoped.token)).status, 404);
    await unscopedApp.close();
  } finally { await app.close(); }
});

test("escalations go to the customer's own Slack webhook, falling back to the server-wide one", async () => {
  const { customers, reviewers, acme, globex } = setup();
  customers.setSlackWebhook(acme.customer.id, "https://hooks.slack.com/services/T000/B000/ACME");
  const posted: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url.startsWith("https://hooks.slack.com/")) { posted.push(url); return new Response("ok", { status: 200 }); }
    return realFetch(input, init);
  }) as typeof fetch;
  const app = await startApp({ customers, reviewers, slackWebhookUrl: "https://hooks.slack.com/services/T000/B000/SERVERWIDE" });
  try {
    await escalate(app.baseUrl, acme);
    await escalate(app.baseUrl, globex);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(posted.sort(), ["https://hooks.slack.com/services/T000/B000/ACME", "https://hooks.slack.com/services/T000/B000/SERVERWIDE"]);
  } finally { globalThis.fetch = realFetch; await app.close(); }
});

test("only Slack incoming-webhook URLs are accepted for a customer", () => {
  const customers = new CustomerStore();
  const { id } = customers.create("Acme");
  for (const bad of ["http://hooks.slack.com/services/T/B/X", "https://evil.example/services/T/B/X", "https://hooks.slack.com.evil.example/services/T/B/X", "http://169.254.169.254/latest", "https://hooks.slack.com/services/T/B/X?x=1"]) {
    assert.throws(() => customers.setSlackWebhook(id, bad), /Slack webhook/, bad);
  }
  assert.equal(customers.setSlackWebhook(id, "https://hooks.slack.com/services/T000/B000/XXXX"), true);
  assert.equal(customers.list()[0].slackWebhookUrl, "https://hooks.slack.com/services/T000/B000/XXXX");
  assert.equal(customers.setSlackWebhook(id, undefined), true);
  assert.equal(customers.list()[0].slackWebhookUrl, undefined);
  assert.equal(customers.setSlackWebhook("no-such", "https://hooks.slack.com/services/T/B/X"), false);
});
