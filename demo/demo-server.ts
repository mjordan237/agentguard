/**
 * The AgentGuard server configured for local demos: one customer ("Acme Robotics") with a
 * vendor-payments policy, one named reviewer, and a stand-in relayer that returns a fake signature and uses only local HTTP. Used by `npm run quickstart` and `live-flow.ts`.
 */
import http from "node:http";
import { AddressInfo } from "node:net";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer } from "../src/api/server.js";
import { CustomerStore } from "../src/customers/customer-store.js";
import { ReviewerStore } from "../src/escalation/reviewer-store.js";
import { buildDemoRegistry } from "./policy.js";

const SOL = 1_000_000_000;

export interface DemoInfo {
  baseUrl: string;
  apiKey: string;
  reviewerToken: string;
  policyId: string;
  agentId: string;
  /** Ready-made base64 transactions: a normal payment, one with a hidden instruction, a stranger, and an over-limit amount. */
  transactions: { legitimate: string; hidden: string; stranger: string; overLimit: string };
  addresses: { vendor: string; stranger: string; attackerProgram: string };
}

export interface DemoServer {
  info: DemoInfo;
  /** How many signatures the stand-in relayer has issued. */
  signedCount(): number;
  close(): Promise<void>;
}

/** Asks the OS for a free port, so "port 0" can still produce correct review links. */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, () => resolve()); });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

export async function startDemoServer(requestedPort: number): Promise<DemoServer> {
  const port = requestedPort === 0 ? await freePort() : requestedPort;
  const feePayer = Keypair.generate();
  const agent = Keypair.generate().publicKey;
  const vendor = Keypair.generate().publicKey;
  const stranger = Keypair.generate().publicKey;
  const attackerProgram = Keypair.generate().publicKey;
  let signed = 0;

  const relayer = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const rpc = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      if (rpc.method === "getPayerSigner") {
        return void res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signer_address: feePayer.publicKey.toBase58(), payment_address: feePayer.publicKey.toBase58() } }));
      }
      signed += 1;
      res.end(JSON.stringify({ id: rpc.id, jsonrpc: "2.0", result: { signature: `stand-in-relayer-signature-${signed}`, signed_transaction: "x", signer_pubkey: feePayer.publicKey.toBase58() } }));
    });
  });
  await new Promise<void>((r) => relayer.listen(0, () => r()));
  const relayerPort = (relayer.address() as AddressInfo).port;

  const customers = new CustomerStore();
  const reviewers = new ReviewerStore();
  const acme = customers.create("Acme Robotics", 100_000);
  customers.setPolicy(acme.id, {
    policyId: "vendor-payments",
    programAllowlist: [SystemProgram.programId.toBase58()],
    destinationAllowlist: [vendor.toBase58()],
    maxAmountPerTransaction: { native: String(1 * SOL) },
    maxAmountPerDay: { native: String(5 * SOL) }
  });
  const apiKey = customers.issueKey(acme.id).apiKey;
  const reviewer = reviewers.create("Alice (finance lead)", acme.id);

  const app = createServer(new Map(), buildDemoRegistry(), {
    baseUrl: `http://localhost:${port}`, reviewActionSecret: "demo-secret", customers, reviewers,
    rateLimit: { maxRequests: 100_000, windowMs: 60_000 },
    koraGate: { client: new KoraClient({ rpcUrl: `http://localhost:${relayerPort}` }) }
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, () => resolve()); });
  const actualPort = (server.address() as AddressInfo).port;

  const build = (instructions: ReturnType<typeof SystemProgram.transfer>[]) => Buffer.from(new VersionedTransaction(new TransactionMessage({
    payerKey: feePayer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions
  }).compileToV0Message()).serialize()).toString("base64");
  const pay = (to: PublicKey, sol: number) => SystemProgram.transfer({ fromPubkey: agent, toPubkey: to, lamports: Math.round(sol * SOL) });
  const hijack = SystemProgram.assign({ accountPubkey: agent, programId: attackerProgram });

  return {
    info: {
      baseUrl: `http://localhost:${actualPort}`, apiKey, reviewerToken: reviewer.token, policyId: "vendor-payments", agentId: "procurement-agent",
      transactions: { legitimate: build([pay(vendor, 0.25)]), hidden: build([pay(vendor, 0.25), hijack]), stranger: build([pay(stranger, 0.25)]), overLimit: build([pay(vendor, 3)]) },
      addresses: { vendor: vendor.toBase58(), stranger: stranger.toBase58(), attackerProgram: attackerProgram.toBase58() }
    },
    signedCount: () => signed,
    close: () => new Promise<void>((resolve) => {
      server.close(() => relayer.close(() => resolve()));
      server.closeAllConnections();
      relayer.closeAllConnections();
    })
  };
}
