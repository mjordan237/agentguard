import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createServer } from "../src/api/server.js";
import { parseAndDecodeTransaction } from "../src/agent-integration/parse-transaction.js";
import { evaluatePolicy } from "../src/policy/evaluate.js";
import { buildDemoPolicy, buildDemoRegistry } from "../demo/policy.js";

// Real Solana mainnet version-1 transactions, copied from finalized blocks (slot, index noted).
// Version 1 carries compute settings and the priority fee in the message's own config instead of
// ComputeBudget instructions. Measured on mainnet: charged fee = 5000 x signatures + priorityFee.

/** Slot 458422036 #312: one System transfer of 186398542 lamports, priorityFee 600. */
const V1_TRANSFER_WITH_FEE = "gQEAAg8AAAD0PUfmvONUmcWM5Mqq2vZAeX/0OZIm9gsFMkU1Brvn4QEEviAhSXMeD6K04LekoI/x6vuJrQeX2N48uibksvdxwOJPZeyuNgmVfHf0zXyD9R58gTL3oA+vn3T0BdgX9QUGxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASQw3XpXW8Eup9D+cgwlYAgAAAAAAALgLAAAAAAAEAgIMAAABAgAAAE43HAsAAAAAPN21wIY/uMookt/q0dMTOCSVg4ioSKcIvpDOa8MoQR09NgK68EKc/KsU/zRbr7ghWk8XVl537WYVOlfuI86iCw==";
/** Slot 458422047 #81: one System transfer, priorityFee 0. */
const V1_TRANSFER_NO_FEE = "gQEAAgwAAAAqpv2X2he/XHBdhLTzmbPZ+D2lN8oyyyIQ16Nwif38dwEEs8oqmvYGvPMwEp9+d0kzO4ee6EwcRdDtMvjFu5qEJp/xh+yH0fdFyzoDOEompp7aDKLRqg9B5CQWN36R/1tdMQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA7yQ4K2z3gnrDjF1dcZZwuUuXenG2C1zj0tqjI9me77GWAAAAACAAAAICDAAAAQIAAAAXBwAAAAAAAN8ZgEl0JZiHjp3BYh/NcKZH8tFGkn5vPRdPU/zuTZ9WoMi3KfR/Zfs5MrQvbsQUOyJKZdiiPFxT+p3idiT4FQo=";
/** Slot 458422047 #156: no instructions at all. */
const V1_EMPTY = "gQEAAQ8AAAAqpv2X2he/XHBdhLTzmbPZ+D2lN8oyyyIQ16Nwif38dwAClIsPCfUvu8gd4bsKIwcC5No+1Sm3+JKWFeU9WY/OCoh59rYZLlB7KV9KIpy3lHfrQuJz+0WN0jgI6vIigGdrq3mlAQAAAAAAAAAAAAAgAACBU4Ng5qrSltMv3YI19IQ/YHIoe5aRKprfRLWF90fQNVXtG2GLHmiP6qYowSaGrdS4HI8V6Enpbe0CK+/VXlgL";

const HIGH_LIMIT = "1000000000000";

async function destinationOf(transactionBase64: string): Promise<string> {
  const decoded = await parseAndDecodeTransaction(transactionBase64, buildDemoRegistry());
  const destination = decoded.instructions[0]?.destination;
  assert.ok(destination, "fixture should decode to a transfer with a destination");
  return destination;
}

test("a version-1 transaction's priority fee is read from its config", async () => {
  const decoded = await parseAndDecodeTransaction(V1_TRANSFER_WITH_FEE, buildDemoRegistry());
  assert.equal(decoded.messageVersion, 1);
  assert.equal(decoded.priorityFee, 600n);
  assert.equal(decoded.instructions.length, 1);
  assert.equal(decoded.instructions[0].amount, 186398542n);
});

test("legacy and v0 transactions carry no priority fee field", async () => {
  const payer = Keypair.generate();
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [] }).compileToV0Message();
  const decoded = await parseAndDecodeTransaction(Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"), buildDemoRegistry());
  assert.equal(decoded.messageVersion, 0);
  assert.equal(decoded.priorityFee, undefined);
});

test("a v1 transfer with a priority fee is NOT allowed when the policy sets no priority-fee limit", async () => {
  const destination = await destinationOf(V1_TRANSFER_WITH_FEE);
  const decoded = await parseAndDecodeTransaction(V1_TRANSFER_WITH_FEE, buildDemoRegistry());
  const evaluation = evaluatePolicy(decoded, buildDemoPolicy([destination], HIGH_LIMIT, HIGH_LIMIT));
  assert.equal(evaluation.decision, "NEEDS_REVIEW");
  assert.match(evaluation.reasons.join(" "), /priority fee of 600 lamports and the policy defines no priority-fee limit/);
});

test("the priority-fee limit is enforced both ways", async () => {
  const destination = await destinationOf(V1_TRANSFER_WITH_FEE);
  const decoded = await parseAndDecodeTransaction(V1_TRANSFER_WITH_FEE, buildDemoRegistry());
  const policy = buildDemoPolicy([destination], HIGH_LIMIT, HIGH_LIMIT);

  assert.equal(evaluatePolicy(decoded, { ...policy, maxPriorityFeePerTransaction: "600" }).decision, "ALLOW");
  const over = evaluatePolicy(decoded, { ...policy, maxPriorityFeePerTransaction: "599" });
  assert.equal(over.decision, "NEEDS_REVIEW");
  assert.match(over.reasons.join(" "), /Priority fee 600 lamports exceeds the limit of 599/);
});

test("a v1 transfer with zero priority fee is still allowed by an otherwise passing policy", async () => {
  const destination = await destinationOf(V1_TRANSFER_NO_FEE);
  const decoded = await parseAndDecodeTransaction(V1_TRANSFER_NO_FEE, buildDemoRegistry());
  assert.equal(decoded.priorityFee, 0n);
  assert.equal(evaluatePolicy(decoded, buildDemoPolicy([destination], HIGH_LIMIT, HIGH_LIMIT)).decision, "ALLOW");
});

test("a transaction with no instructions is sent to review, not allowed by default", async () => {
  const v1 = evaluatePolicy(await parseAndDecodeTransaction(V1_EMPTY, buildDemoRegistry()), buildDemoPolicy());
  assert.equal(v1.decision, "NEEDS_REVIEW");
  assert.match(v1.reasons.join(" "), /contains no instructions/);

  const payer = Keypair.generate();
  const message = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [] }).compileToV0Message();
  const v0 = evaluatePolicy(
    await parseAndDecodeTransaction(Buffer.from(new VersionedTransaction(message).serialize()).toString("base64"), buildDemoRegistry()),
    buildDemoPolicy()
  );
  assert.equal(v0.decision, "NEEDS_REVIEW");
});

test("end to end: /evaluate sends the real v1 transfer-with-priority-fee to review", async () => {
  const destination = await destinationOf(V1_TRANSFER_WITH_FEE);
  const app = createServer(new Map([["demo", buildDemoPolicy([destination], HIGH_LIMIT, HIGH_LIMIT)]]), buildDemoRegistry(), { baseUrl: "http://placeholder" });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://localhost:${port}/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "a", policyId: "demo", transactionBase64: V1_TRANSFER_WITH_FEE })
    });
    const body = (await response.json()) as { decision: string; reasons: string[] };
    assert.equal(body.decision, "NEEDS_REVIEW");
    assert.match(body.reasons.join(" "), /priority fee/);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
