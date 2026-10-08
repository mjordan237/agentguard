import { Connection, PublicKey } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer, type ServerConfig } from "./api/server.js";
import type { LookupTableResolver } from "./agent-integration/parse-transaction.js";
import { parseKnownCluster } from "./gateway/squads-upgrade-gate.js";
import { detectSolanaNetwork, networkStartupLines } from "./network/cluster-detection.js";
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
// verify.osec.io's remote verification is mainnet-only -- unset or any
// value other than "mainnet-beta" means /squads/upgrade-check's
// verification checks return UNKNOWN rather than silently assuming
// mainnet. The default devnet RPC above intentionally does NOT imply a
// cluster value here; they're configured independently.
const solanaCluster = parseKnownCluster(process.env.SOLANA_CLUSTER);
const reviewExpiryMs = Number(process.env.REVIEW_EXPIRY_MS ?? 15 * 60_000);
if (!Number.isFinite(reviewExpiryMs) || reviewExpiryMs <= 0) {
  throw new Error("REVIEW_EXPIRY_MS must be a positive number of milliseconds.");
}
const persistencePath = process.env.AGENTGUARD_DB_PATH ?? "agentguard.sqlite";

const config: ServerConfig = {
  baseUrl: process.env.BASE_URL ?? `http://localhost:${port}`,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  resolveLookupTable,
  koraGate: koraRpcUrl ? { client: new KoraClient({ rpcUrl: koraRpcUrl }) } : undefined,
  connection,
  solanaCluster,
  reviewActionSecret: process.env.REVIEW_ACTION_SECRET,
  reviewExpiryMs,
  persistencePath
};

async function start(): Promise<void> {
  try {
    const detection = await detectSolanaNetwork(connection);
    for (const line of networkStartupLines(detection, solanaCluster)) console.log(line);
  } catch (error) {
    console.error(`!!! RPC NETWORK DETECTION FAILED !!! Could not read genesis hash from ${rpcUrl}: ${(error as Error).message}`);
    console.error("No network identity is being assumed from SOLANA_CLUSTER alone.");
  }

  createServer(policies, registry, config).listen(port, () => {
  console.log(`AgentGuard listening on :${port}`);
  console.log(`Resolving Address Lookup Tables via ${rpcUrl}`);
  console.log(`Persisting reviews, evaluation history, and daily spend in ${persistencePath}`);
  if (!config.slackWebhookUrl) {
    console.log("SLACK_WEBHOOK_URL not set -- NEEDS_REVIEW decisions will only create a review page, no Slack post.");
  }
  if (!koraRpcUrl) {
    console.log("KORA_RPC_URL not set -- /gate-and-sign will fail closed with KORA_NOT_CONFIGURED for any ALLOWed transaction.");
  }
  if (!solanaCluster) {
    console.log('SOLANA_CLUSTER not set to a known value ("mainnet-beta", "devnet", or "testnet") -- /squads/upgrade-check verification checks will return UNKNOWN.');
  }
  if (!config.reviewActionSecret) {
    console.log("REVIEW_ACTION_SECRET not set -- review pages remain visible but approve/deny actions are disabled.");
  }
  });
}

void start();
