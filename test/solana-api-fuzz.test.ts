import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry } from "../demo/policy.js";
import { registerStandardPrograms } from "../src/agent-integration/standard-programs.js";

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const SOL = 1_000_000_000;
const listen = (server: http.Server) => new Promise<{ port: number; close: () => Promise<void> }>((resolve) =>
  server.listen(0, () => resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections(); }) })));

test("solana api: random and malformed requests never produce a 5xx, and a signature only follows an allowed shape", async () => {
  const feePayer = Keypair.generate();
  const vendor = Keypair.generate().publicKey;
  const stranger = Keypair.generate().publicKey;
  const agent = Keypair.generate().publicKey;
  let koraCalls = 0;
  const kora = await listen(http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rpc = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      if (rpc.method === "getPayerSigner") return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signer_address: feePayer.publicKey.toBase58(), payment_address: feePayer.publicKey.toBase58() } }));
      koraCalls += 1;
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signature: `sig-${koraCalls}`, signed_transaction: "x", signer_pubkey: feePayer.publicKey.toBase58() } }));
    });
  }));
  const customers = new CustomerStore();
  const acme = customers.create("acme", 1_000_000);
  customers.setPolicy(acme.id, {
    policyId: "p", programAllowlist: [SystemProgram.programId.toBase58()], destinationAllowlist: [vendor.toBase58()],
    maxAmountPerTransaction: { native: String(1 * SOL) }, maxAmountPerDay: { native: String(1_000_000 * SOL) }
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const registry = registerStandardPrograms(buildDemoRegistry());
  const app = createServer(new Map(), registry, {
    baseUrl: "http://placeholder", reviewActionSecret: "s", customers, reviewers: new ReviewerStore(),
    koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${kora.port}` }) }
  });
  const server = await listen(http.createServer(app));
  const base = `http://localhost:${server.port}`;
  const call = async (method: string, path: string, body?: unknown, raw = false) => {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body === undefined ? undefined : raw ? String(body) : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  const r = rng(909090);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const AMOUNTS = [0, 1, SOL - 1, SOL, SOL + 1, 5 * SOL, Number.MAX_SAFE_INTEGER];
  const txBytes = (instructions: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions }).compileToV0Message()).serialize();
  const tally: Record<number, number> = {};
  try {
    for (let i = 0; i < 700; i++) {
      // Build a transaction whose shape we know, so a signature can be checked against an independent rule.
      const n = 1 + Math.floor(r() * 3);
      const shape: { to: PublicKey; lamports: number; weird?: boolean }[] = [];
      const instructions: TransactionInstruction[] = [];
      for (let k = 0; k < n; k++) {
        if (r() < 0.12) {
          instructions.push(new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [{ pubkey: agent, isSigner: false, isWritable: true }], data: Buffer.from(Array.from({ length: Math.floor(r() * 12) }, () => Math.floor(r() * 256))) }));
          shape.push({ to: stranger, lamports: 0, weird: true });
        } else {
          const to = r() < 0.7 ? vendor : stranger;
          const lamports = pick(AMOUNTS);
          // From the agent: the relayer only pays fees, and a transfer out of it is refused before Kora is called.
          instructions.push(SystemProgram.transfer({ fromPubkey: agent, toPubkey: to, lamports }));
          shape.push({ to, lamports });
        }
      }
      let bytes = Buffer.from(txBytes(instructions));
      const mutate = r();
      if (mutate < 0.1) bytes = bytes.subarray(0, Math.floor(r() * bytes.length));
      else if (mutate < 0.2) bytes[Math.floor(r() * bytes.length)] ^= 1 << Math.floor(r() * 8);
      else if (mutate < 0.25) bytes = Buffer.from(Array.from({ length: Math.floor(r() * 200) }, () => Math.floor(r() * 256)));
      const b64 = r() < 0.05 ? pick(["", "!!!notbase64", "A".repeat(5000), "====", " "]) : bytes.toString("base64");
      const before = koraCalls;
      const path = pick(["/gate-and-sign", "/gate-and-sign", "/evaluate"]);
      const res = await call("POST", path, { agentId: pick(["a1", "a1", "x".repeat(300), ""]), policyId: "p", transactionBase64: b64, reserve: r() < 0.3 ? true : undefined });
      tally[res.status] = (tally[res.status] ?? 0) + 1;
      assert.ok(res.status < 500, `${path} gave ${res.status} ${JSON.stringify(res.body)} for ${b64.slice(0, 80)}`);
      if (koraCalls > before) {
        // Signed. Judge the exact bytes that were sent, with a parser that is not the gate's: every instruction must be a
        // System Program transfer of at most 1 SOL to the vendor.
        assert.equal(path, "/gate-and-sign");
        const sent = Buffer.from(b64, "base64");
        const message = VersionedTransaction.deserialize(sent).message;
        assert.equal(message.addressTableLookups.length, 0);
        for (const ix of message.compiledInstructions) {
          const program = message.staticAccountKeys[ix.programIdIndex];
          const data = Buffer.from(ix.data);
          const lamports = data.length === 12 ? data.readBigUInt64LE(4) : -1n;
          const to = message.staticAccountKeys[ix.accountKeyIndexes[1]];
          const fits = program.equals(SystemProgram.programId) && data.length === 12 && data.readUInt32LE(0) === 2 && ix.accountKeyIndexes.length === 2 && to !== undefined && to.equals(vendor) && lamports <= BigInt(SOL);
          assert.ok(fits, `signed a transaction with an instruction outside the policy: program ${program.toBase58()} data ${data.toString("hex")} to ${to?.toBase58()}`);
        }
      }
    }
    console.log(`# solana fuzz statuses: ${JSON.stringify(tally)}, signed: ${koraCalls}`);
    assert.equal(tally[429] ?? 0, 0, "the rate limiter must not hide requests from validation");
    assert.ok(koraCalls > 5 && (tally[400] ?? 0) > 20, `the mix should include signatures and rejections: ${JSON.stringify(tally)}, signed ${koraCalls}`);

    // Odd bodies and odd query strings on every endpoint.
    for (const raw of ["{not json", "[]", "null", "\"s\"", "123", ""]) {
      for (const path of ["/evaluate", "/gate-and-sign", "/squads/upgrade-check"]) {
        const res = await call("POST", path, raw, true);
        assert.equal(res.status, 400, `${path} raw ${JSON.stringify(raw)} gave ${res.status}`);
      }
    }
    for (const body of [{}, { multisigPda: "x", transactionIndex: "1" }, { multisigPda: 5, transactionIndex: {} }, { multisigPda: PublicKey.default.toBase58(), transactionIndex: -1 }, { multisigPda: PublicKey.default.toBase58(), transactionIndex: "1e9" }, { multisigPda: PublicKey.default.toBase58(), transactionIndex: 2 ** 70 }]) {
      const res = await call("POST", "/squads/upgrade-check", body);
      assert.ok(res.status < 500 || res.status === 503, `squads gave ${res.status} for ${JSON.stringify(body)}`);
      assert.notEqual(res.status, 500);
    }
    for (const q of ["", "?limit=-1", "?limit=abc", "?limit=1e9", "?limit=999999999999", "?decision=garbage", "?decision=ALLOW&limit=3", "?limit=%00"]) {
      for (const path of [`/agents/a1/history${q}`, `/agents/${encodeURIComponent("../../etc")}/history${q}`, `/reviews/${encodeURIComponent("x'--")}`, `/transactions/${"9".repeat(500)}`]) {
        const res = await call("GET", path);
        assert.ok(res.status < 500, `GET ${path} gave ${res.status} ${JSON.stringify(res.body)}`);
      }
    }
  } finally {
    await server.close();
    await kora.close();
  }
});
