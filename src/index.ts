import { Connection, PublicKey } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer, type ServerConfig } from "./api/server.js";
import type { LookupTableResolver } from "./agent-integration/parse-transaction.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";
import type { Policy } from "./policy/types.js";

const registry = buildDemoRegistry();
const demoPolicy: Policy = buildDemoPolicy();
const policies = new Map<string, Policy>([[demoPolicy.policyId, demoPolicy]]);

const port = Number(process.env.PORT ?? 8787);
const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const connection = new Connection(rpcUrl, "confirmed");

// Real Address Lookup Table resolution via RPC, not a stub -- a
// transaction using an ALT will actually be resolved here, or fail
// closed to NEEDS_REVIEW if the table doesn't exist or the RPC call
// errors (see parse-transaction.ts's unresolvableAltSummary).
const resolveLookupTable: LookupTableResolver = async (address: PublicKey) => {
  try {
    const result = await connection.getAddressLookupTable(address);
    return result.value;
  } catch (error) {
    console.error(`Failed to resolve address lookup table ${address.toBase58()}:`, error);
    return null;
  }
};

const koraRpcUrl = process.env.KORA_RPC_URL;

const config: ServerConfig = {
  baseUrl: process.env.BASE_URL ?? `http://localhost:${port}`,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  resolveLookupTable,
  koraGate: koraRpcUrl ? { client: new KoraClient({ rpcUrl: koraRpcUrl }) } : undefined
};

createServer(policies, registry, config).listen(port, () => {
  console.log(`AgentGuard listening on :${port}`);
  console.log(`Resolving Address Lookup Tables via ${rpcUrl}`);
  if (!config.slackWebhookUrl) {
    console.log("SLACK_WEBHOOK_URL not set -- NEEDS_REVIEW decisions will only create a review page, no Slack post.");
  }
  if (!koraRpcUrl) {
    console.log("KORA_RPC_URL not set -- /gate-and-sign will fail closed with KORA_NOT_CONFIGURED for any ALLOWed transaction.");
  }
});
