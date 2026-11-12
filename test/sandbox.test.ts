import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSandboxServer } from "../src/sandbox/server.js";
import { canonicalJson } from "../src/check/engine.js";

const CLI = path.resolve(import.meta.dirname, "../src/cli/check.js");

async function start(config: Parameters<typeof createSandboxServer>[0] = {}) {
  const server = http.createServer(createSandboxServer(config));
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (route: string, body: unknown, raw = false) => {
    const response = await fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: raw ? (body as string) : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  return { base, post, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

/** Runs the published CLI on the same input, from files, the way a developer would. */
function cli(body: any): any {
  const dir = mkdtempSync(path.join(tmpdir(), "sandbox-verify-"));
  writeFileSync(path.join(dir, "policy.json"), JSON.stringify(body.policy));
  const args = [CLI, "--json", "--policy", path.join(dir, "policy.json")];
  if (body.chain === "evm") { writeFileSync(path.join(dir, "tx.json"), JSON.stringify(body.transaction)); args.push("--evm-tx", path.join(dir, "tx.json")); }
  else { writeFileSync(path.join(dir, "tx.b64"), body.transactionBase64); args.push("--tx-file", path.join(dir, "tx.b64")); }
  if (body.spentToday) args.push("--spent", Object.entries(body.spentToday).map(([asset, amount]) => `${asset}=${amount}`).join(","));
  if (body.lookupTables) { writeFileSync(path.join(dir, "tables.json"), JSON.stringify(body.lookupTables)); args.push("--lookup-tables", path.join(dir, "tables.json")); }
  const run = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.ok(run.status === 0 || run.status === 2, run.stderr);
  return JSON.parse(run.stdout);
}

test("every example gets its expected decision, and the CLI reproduces the API's receipt exactly", async () => {
  const sandbox = await start();
  try {
    const { examples } = (await (await fetch(`${sandbox.base}/v1/examples`)).json()) as { examples: any[] };
    assert.ok(examples.length >= 5);
    for (const example of examples) {
      const api = await sandbox.post("/v1/check", example.body);
      assert.equal(api.status, 200, `${example.name}: ${JSON.stringify(api.body)}`);
      assert.equal(api.body.decision, example.expect, `${example.name}: ${api.body.reasons?.join("; ")}`);
      const local = cli(example.body);
      assert.deepEqual(local.receipt, api.body.receipt, `${example.name}: the CLI and the API disagree`);
    }
  } finally {
    await sandbox.close();
  }
});

test("a receipt does not depend on key order or formatting, and changes when the input does", async () => {
  const sandbox = await start();
  try {
    const { examples } = (await (await fetch(`${sandbox.base}/v1/examples`)).json()) as { examples: any[] };
    const body = examples[0].body;
    const reordered = JSON.parse(canonicalJson(body));
    reordered.policy = Object.fromEntries(Object.entries(body.policy).reverse());
    const a = await sandbox.post("/v1/check", body), b = await sandbox.post("/v1/check", JSON.stringify(reordered, null, 7), true);
    assert.deepEqual(a.body.receipt, b.body.receipt);
    const changed = await sandbox.post("/v1/check", { ...body, policy: { ...body.policy, maxAmountPerDay: { native: "5000000001" } } });
    assert.notEqual(changed.body.receipt.inputHash, a.body.receipt.inputHash, "a different policy is a different input");
    assert.equal(changed.body.receipt.resultHash, a.body.receipt.resultHash, "the same answer is the same result");
  } finally {
    await sandbox.close();
  }
});

test("a real mainnet Jupiter swap with lookup tables in the request is checked, and the CLI agrees", async () => {
  const fixture = (JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../test/fixtures/jupiter-mainnet.json"), "utf8")) as { transactions: any[] }).transactions.find((t) => t.kind === "route_v2");
  // Rebuild each table from the addresses the transaction loaded; indexes it did not use hold a placeholder.
  const writable = [...fixture.loadedAddresses.writable], readonly = [...fixture.loadedAddresses.readonly];
  const lookupTables: Record<string, string[]> = {};
  for (const lookup of fixture.lookups) {
    const addresses = Array.from({ length: Math.max(...lookup.writableIndexes, ...lookup.readonlyIndexes) + 1 }, () => "11111111111111111111111111111111");
    for (const index of lookup.writableIndexes) addresses[index] = writable.shift();
    for (const index of lookup.readonlyIndexes) addresses[index] = readonly.shift();
    lookupTables[lookup.table] = addresses;
  }
  const policy = { policyId: "swap", programAllowlist: [], destinationAllowlist: [], maxAmountPerTransaction: {}, maxAmountPerDay: {} };
  const sandbox = await start();
  try {
    const body = { chain: "solana", transactionBase64: fixture.transactionBase64, policy, lookupTables };
    const api = await sandbox.post("/v1/check", body);
    assert.equal(api.status, 200, JSON.stringify(api.body));
    assert.ok(api.body.decoded.instructions.some((i: any) => i.instructionName === "route_v2" && i.mode === "interpolated"), "the swap was read through the supplied tables");
    assert.deepEqual(Object.keys(api.body.lookupTables).sort(), Object.keys(lookupTables).sort());
    assert.deepEqual(cli(body).receipt, api.body.receipt);
  } finally {
    await sandbox.close();
  }
});

test("policy problems are listed one by one, and validation explains settings that hold everything", async () => {
  const sandbox = await start();
  try {
    const bad = await sandbox.post("/v1/check", { transactionBase64: "AA==", policy: { policyId: "x", maxAmountPerTx: {} } });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.problems.length >= 3, JSON.stringify(bad.body));
    const invalid = await sandbox.post("/v1/policies/validate", { policy: { policyId: "x" } });
    assert.equal(invalid.body.valid, false);
    const valid = await sandbox.post("/v1/policies/validate", { policy: { policyId: "x", programAllowlist: [], destinationAllowlist: [], maxAmountPerTransaction: {}, maxAmountPerDay: {} } });
    assert.equal(valid.body.valid, true);
    assert.ok(valid.body.notes.length >= 3);
  } finally {
    await sandbox.close();
  }
});

test("the sandbox cannot sign, keeps nothing, refuses oversized or malformed bodies, and rate-limits", async () => {
  const sandbox = await start({ rateLimit: { maxRequests: 3, windowMs: 60_000 } });
  try {
    for (const route of ["/gate-and-sign", "/evaluate", "/review/x/approve", "/audit"]) {
      assert.equal((await sandbox.post(route, {})).status, 404, `${route} does not exist here`);
    }
    assert.equal((await sandbox.post("/v1/check", "{not json", true)).status, 400);
    assert.equal((await sandbox.post("/v1/check", { transactionBase64: "A".repeat(70_000), policy: {} })).status, 413);
    assert.equal((await sandbox.post("/v1/check", { chain: "bitcoin", policy: {} })).status, 400);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await sandbox.post("/v1/policies/validate", { policy: {} })).status);
    assert.ok(statuses.includes(429), `expected a 429 in ${statuses}`);
    const page = await fetch(`${sandbox.base}/`);
    const html = await page.text();
    assert.match(html, /Verify a result yourself/);
    assert.match(html, /git clone https:\/\/github.com\/mjordan237\/agentguard/);
    assert.match(html, new RegExp(`curl -s http://127.0.0.1:\\d+/v1/check`), "the page shows this server's own address");
    const openapi = await (await fetch(`${sandbox.base}/openapi.json`)).json() as any;
    assert.ok(openapi.paths["/v1/check"].post);
  } finally {
    await sandbox.close();
  }
});

test("the docs page escapes the Host header, which the visitor controls", async () => {
  const sandbox = await start({ sourceCommit: "abc123" });
  try {
    const port = new URL(sandbox.base).port;
    const html = await new Promise<string>((resolve) => {
      http.get({ host: "127.0.0.1", port, path: "/", headers: { host: '"><script>alert(1)</script>' } }, (res) => { let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve(body)); });
    });
    assert.ok(!html.includes("<script>alert(1)</script>"), "the injected tag is not written into the page");
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /git checkout abc123/);
  } finally {
    await sandbox.close();
  }
});

test("leaving spentToday out and sending zero give the same receipt", async () => {
  const sandbox = await start();
  try {
    const { examples } = (await (await fetch(`${sandbox.base}/v1/examples`)).json()) as { examples: any[] };
    const { spentToday: _omit, ...body } = examples[0].body;
    const omitted = await sandbox.post("/v1/check", body);
    const zero = await sandbox.post("/v1/check", { ...body, spentToday: { native: "0" } });
    assert.deepEqual(zero.body.receipt, omitted.body.receipt);
    assert.deepEqual(cli({ ...body, spentToday: { native: "0" } }).receipt, omitted.body.receipt, "the CLI with --spent native=0 agrees");
    const nonzero = await sandbox.post("/v1/check", { ...body, spentToday: { native: "1" } });
    assert.notEqual(nonzero.body.receipt.inputHash, omitted.body.receipt.inputHash, "a real amount still changes the input");
  } finally {
    await sandbox.close();
  }
});
