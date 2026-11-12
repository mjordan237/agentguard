import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { KoraClient } from "@solana/kora";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createServer, type ServerConfig } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";
import type { Policy } from "../src/policy/types.js";

function barrier() {
  let arrive!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => { arrive = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, pause: async () => { arrive(); await wait; } };
}
async function serve(config: Partial<ServerConfig>, policies = new Map<string, Policy>()) {
  const app = createServer(policies, buildDemoRegistry(), { baseUrl: "http://localhost", ...config });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    post: (path: string, body: unknown, apiKey?: string) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body)
    }),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })
  };
}
const address = "0x1111111111111111111111111111111111111111";
const vendor = "0x2222222222222222222222222222222222222222";
const evmPolicy: Policy = { policyId: "pay", programAllowlist: ["evm:native"], destinationAllowlist: [vendor], maxAmountPerTransaction: { native: "1000", "evm:gas": "100000" }, maxAmountPerDay: { native: "10000", "evm:gas": "1000000" }, allowedChainIds: [1] };
const evmBody = { agentId: "agent", policyId: "pay", transaction: { chainId: 1, from: address, to: vendor, value: "100", nonce: "0", gasLimit: "21000", maxFeePerGas: "1", maxPriorityFeePerGas: "1" } };

for (const change of ["revoke", "policy"] as const) {
  test(`signing freshness: ${change} during EVM code lookup prevents signing`, async () => {
    const customers = new CustomerStore(), customer = customers.create("tenant");
    customers.setPolicy(customer.id, evmPolicy);
    const key = customers.issueKey(customer.id).apiKey, gate = barrier();
    let signatures = 0;
    const app = await serve({ customers, evmCodeLookup: async () => { await gate.pause(); return "0x"; }, evmSigner: { address, signTransaction: async () => { signatures++; return "0x00"; } } });
    try {
      const request = app.post("/gate-and-sign-evm", evmBody, key);
      await gate.entered;
      if (change === "revoke") customers.revoke(customer.id);
      else customers.setPolicy(customer.id, { ...evmPolicy, destinationAllowlist: [] });
      gate.release();
      const response = await request;
      assert.equal(signatures, 0, "stale authorization must not reach the signer");
      assert.equal(response.status, change === "revoke" ? 403 : 409);
    } finally { gate.release(); await app.close(); }
  });
}

test("signing freshness: revocation while signing prevents subsequent server broadcast", async () => {
  const customers = new CustomerStore(), customer = customers.create("tenant");
  customers.setPolicy(customer.id, evmPolicy);
  const key = customers.issueKey(customer.id).apiKey, gate = barrier();
  let broadcasts = 0;
  const app = await serve({ customers, evmSigner: { address, signTransaction: async () => { await gate.pause(); return "0x00"; } }, evmBroadcaster: async () => { broadcasts++; return "0xhash"; } });
  try {
    const request = app.post("/gate-and-sign-evm", { ...evmBody, broadcast: true }, key);
    await gate.entered;
    customers.revoke(customer.id); gate.release();
    const response = await request;
    assert.equal(broadcasts, 0, "the server must not broadcast after revocation");
    assert.equal(response.status, 403);
  } finally { gate.release(); await app.close(); }
});

async function solanaWorld(pausePayer: boolean, upstreamError?: string) {
  const customers = new CustomerStore(), customer = customers.create("tenant"), gate = barrier();
  const payer = Keypair.generate(), agent = Keypair.generate(), to = Keypair.generate();
  customers.setPolicy(customer.id, { policyId: "sol", programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [to.publicKey.toBase58()], maxAmountPerTransaction: { native: "1000" }, maxAmountPerDay: { native: "10000" } });
  let sends = 0;
  const client = {
    getPayerSigner: async () => { if (pausePayer) await gate.pause(); return { signer_address: payer.publicKey.toBase58() }; },
    signAndSendTransaction: async () => { sends++; if (upstreamError) throw new Error(upstreamError); return { signature: "local-fake" }; }
  } as unknown as KoraClient;
  const app = await serve({ customers, koraGate: { client } });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({ fromPubkey: agent.publicKey, toPubkey: to.publicKey, lamports: 100 })] }).compileToV0Message());
  const key = customers.issueKey(customer.id).apiKey;
  return { ...app, gate, revoke: () => customers.revoke(customer.id), sends: () => sends, request: () => app.post("/gate-and-sign", { agentId: "a", policyId: "sol", transactionBase64: Buffer.from(tx.serialize()).toString("base64") }, key) };
}

test("signing freshness: revocation during Kora payer lookup prevents sign-and-send", async () => {
  const app = await solanaWorld(true);
  try {
    const request = app.request(); await app.gate.entered;
    app.revoke(); app.gate.release();
    const response = await request;
    assert.equal(app.sends(), 0, "payer lookup is an async authorization boundary");
    assert.equal(response.status, 403);
  } finally { app.gate.release(); await app.close(); }
});

test("Kora errors: upstream diagnostics are not reflected to the HTTP caller", async () => {
  const marker = "synthetic-upstream-credential-marker";
  const app = await solanaWorld(false, `fetch https://rpc.invalid/${marker} failed`);
  try {
    const response = await app.request();
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes(marker), "upstream errors can contain RPC credentials");
  } finally { await app.close(); }
});

test("Squads errors: RPC credentials in upstream failures are not reflected to callers", async () => {
  const marker = "synthetic-rpc-credential-marker";
  const connection = { getAccountInfo: async () => { throw new Error(`fetch https://rpc.invalid/${marker} failed`); } } as unknown as import("@solana/web3.js").Connection;
  const app = await serve({ connection });
  try {
    const response = await app.post("/squads/upgrade-check", { multisigPda: Keypair.generate().publicKey.toBase58(), transactionIndex: "0" });
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes(marker), "RPC failures must not expose endpoint credentials");
  } finally { await app.close(); }
});
