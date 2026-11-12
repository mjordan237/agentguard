import { Connection, PublicKey } from "@solana/web3.js";
import { KoraClient } from "@solana/kora";
import { createServer, type ServerConfig } from "./api/server.js";
import { withLookupTimeout, type LookupTableResolver } from "./agent-integration/parse-transaction.js";
import { parseKnownCluster } from "./gateway/squads-upgrade-gate.js";
import { assertConfiguredNetwork, detectSolanaNetwork, networkStartupLines } from "./network/cluster-detection.js";
import { buildDemoRegistry, buildDemoPolicy } from "../demo/policy.js";
import { registerStandardPrograms } from "./agent-integration/standard-programs.js";
import type { Policy } from "./policy/types.js";
import { evmConfigFromEnv } from "./evm/config.js";
import { parseTrustProxy, trustProxyStartupLine } from "./api/trust-proxy.js";
import { productionConfigProblems, reviewSecretProblem } from "./api/production-config.js";
import { rpcSwapSimulator } from "./gateway/swap-simulation.js";
import { turnkeyConfigFromEnv } from "./turnkey/config.js";
import { endpointLabel } from "./network/endpoint-label.js";

// System transfer, SPL Token / Token-2022 TransferChecked, and ComputeBudget. Anything else is unverifiable
// and goes to review.
const registry = registerStandardPrograms(buildDemoRegistry());

// AGENTGUARD_PRODUCTION=true refuses to start unless every control that protects customers is on, so a
// forgotten environment variable cannot leave a production deployment open.
const productionValue = process.env.AGENTGUARD_PRODUCTION;
if (productionValue !== undefined && productionValue !== "true" && productionValue !== "false") {
  throw new Error("AGENTGUARD_PRODUCTION must be exactly true or false when set.");
}
const production = productionValue === "true";

// The built-in demo policy exists for demos. A production deployment serves customers' own policies only.
const demoPolicy: Policy = buildDemoPolicy();
const policies = production ? new Map<string, Policy>() : new Map<string, Policy>([[demoPolicy.policyId, demoPolicy]]);

const port = Number(process.env.PORT ?? 8787);
const rpcUrl = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const connection = new Connection(rpcUrl, "confirmed");

// Real Address Lookup Table resolution via RPC, not a stub -- a
// transaction using an ALT will actually be resolved here, or fail
// closed to NEEDS_REVIEW if the table doesn't exist or the RPC call
// errors (see parse-transaction.ts's unresolvableAltSummary).
const resolveLookupTable: LookupTableResolver = withLookupTimeout(async (address: PublicKey) => {
  try {
    const result = await connection.getAddressLookupTable(address);
    return result.value;
  } catch (error) {
    console.error(`Failed to resolve address lookup table ${address.toBase58()} via ${endpointLabel(rpcUrl)}.`);
    return null;
  }
});

const koraRpcUrl = process.env.KORA_RPC_URL;
// verify.osec.io's remote verification is mainnet-only -- unset or any
// value other than "mainnet-beta" means /squads/upgrade-check's
// verification checks return UNKNOWN rather than silently assuming
// mainnet. The default devnet RPC above intentionally does NOT imply a
// cluster value here; they're configured independently.
const solanaCluster = parseKnownCluster(process.env.SOLANA_CLUSTER);
const strictNetworkMatchValue = process.env.REQUIRE_RPC_NETWORK_MATCH;
if (strictNetworkMatchValue !== undefined && strictNetworkMatchValue !== "true" && strictNetworkMatchValue !== "false") {
  throw new Error("REQUIRE_RPC_NETWORK_MATCH must be exactly true or false when set.");
}
const requireRpcNetworkMatch = solanaCluster === "mainnet-beta" || strictNetworkMatchValue === "true";
const reviewExpiryMs = Number(process.env.REVIEW_EXPIRY_MS ?? 15 * 60_000);
if (!Number.isFinite(reviewExpiryMs) || reviewExpiryMs <= 0) {
  throw new Error("REVIEW_EXPIRY_MS must be a positive number of milliseconds.");
}
const persistencePath = process.env.AGENTGUARD_DB_PATH ?? "agentguard.sqlite";

const retentionValue = process.env.AGENTGUARD_RETENTION_DAYS ?? "30";
const retentionDays = retentionValue === "off" ? undefined : Number(retentionValue);
if (retentionDays !== undefined && (!Number.isFinite(retentionDays) || retentionDays <= 0)) {
  throw new Error('AGENTGUARD_RETENTION_DAYS must be a positive number of days, or "off".');
}

const requireApiKeysValue = process.env.REQUIRE_API_KEYS;
if (requireApiKeysValue !== undefined && requireApiKeysValue !== "true" && requireApiKeysValue !== "false") {
  throw new Error("REQUIRE_API_KEYS must be exactly true or false when set.");
}
const requireApiKeys = requireApiKeysValue === "true";

const requireReviewersValue = process.env.REVIEW_REQUIRE_REVIEWERS;
if (requireReviewersValue !== undefined && requireReviewersValue !== "true" && requireReviewersValue !== "false") {
  throw new Error("REVIEW_REQUIRE_REVIEWERS must be exactly true or false when set.");
}
const requireReviewers = requireReviewersValue === "true";

const secretProblem = reviewSecretProblem(process.env.REVIEW_ACTION_SECRET);
if (secretProblem) throw new Error(secretProblem);

if (production) {
  const missing = productionConfigProblems(process.env);
  if (missing.length > 0) {
    throw new Error(`AGENTGUARD_PRODUCTION=true but production controls are missing:\n  - ${missing.join("\n  - ")}`);
  }
}

const nebiusApiKey = process.env.NEBIUS_API_KEY;
const nebiusModel = process.env.NEBIUS_MODEL;
if (nebiusApiKey && !nebiusModel) {
  throw new Error("NEBIUS_MODEL must be set when NEBIUS_API_KEY is set (run scripts/list-nebius-models.mjs to find the Nemotron model id).");
}

const swapSimulationValue = process.env.SWAP_SIMULATION;
if (swapSimulationValue !== undefined && swapSimulationValue !== "true" && swapSimulationValue !== "false") {
  throw new Error("SWAP_SIMULATION must be exactly true or false when set.");
}
const swapSimulation = swapSimulationValue !== "false";

const evm = evmConfigFromEnv(process.env, production);
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

const config: ServerConfig = {
  baseUrl: process.env.BASE_URL ?? `http://localhost:${port}`,
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  resolveLookupTable,
  // On whenever there is an RPC to simulate against; SWAP_SIMULATION=false turns it off.
  swapSimulator: swapSimulation ? rpcSwapSimulator(connection) : undefined,
  turnkey: turnkeyConfigFromEnv(process.env),
  koraGate: koraRpcUrl ? { client: new KoraClient({ rpcUrl: koraRpcUrl }) } : undefined,
  connection,
  solanaCluster,
  reviewActionSecret: process.env.REVIEW_ACTION_SECRET,
  requireReviewers,
  requireApiKeys,
  trustProxy,
  reviewExpiryMs,
  persistencePath,
  evmSigner: evm.evmSigner,
  evmCodeLookup: evm.evmCodeLookup,
  evmBroadcaster: evm.evmBroadcaster,
  retentionMs: retentionDays === undefined ? undefined : retentionDays * 86_400_000,
  explainer: nebiusApiKey && nebiusModel
    ? { apiKey: nebiusApiKey, model: nebiusModel, baseUrl: process.env.NEBIUS_BASE_URL }
    : undefined
};

async function start(): Promise<void> {
  try {
    const detection = await detectSolanaNetwork(connection);
    for (const line of networkStartupLines(detection, solanaCluster)) console.log(line);
    if (requireRpcNetworkMatch) {
      try {
        assertConfiguredNetwork(detection, solanaCluster);
      } catch (error) {
        console.error(`!!! RPC NETWORK MISMATCH !!! ${(error as Error).message}`);
        console.error("Startup refused because strict RPC network matching is enabled.");
        process.exitCode = 1;
        return;
      }
    }
  } catch (error) {
    console.error(`!!! RPC NETWORK DETECTION FAILED !!! Could not read genesis hash from ${endpointLabel(rpcUrl)}.`);
    console.error("No network identity is being assumed from SOLANA_CLUSTER alone.");
    if (requireRpcNetworkMatch) {
      console.error("Startup refused because strict RPC network matching is enabled.");
      process.exitCode = 1;
      return;
    }
  }

  createServer(policies, registry, config).listen(port, () => {
  console.log(`AgentGuard listening on :${port}`);
  console.log(`Resolving Address Lookup Tables via ${endpointLabel(rpcUrl)}`);
  console.log(`Persisting reviews, evaluation history, and daily spend in ${persistencePath}`);
  console.log(retentionDays === undefined ? "AGENTGUARD_RETENTION_DAYS=off -- history and reviews are never deleted." : `Deleting evaluation history and reviews older than ${retentionDays} days (AGENTGUARD_RETENTION_DAYS).`);
  if (!config.slackWebhookUrl) {
    console.log("SLACK_WEBHOOK_URL not set -- NEEDS_REVIEW decisions will only create a review page, no Slack post.");
  }
  if (!koraRpcUrl) {
    console.log("KORA_RPC_URL not set -- /gate-and-sign will fail closed with KORA_NOT_CONFIGURED for any ALLOWed transaction.");
  }
  if (!solanaCluster) {
    console.log('SOLANA_CLUSTER not set to a known value ("mainnet-beta", "devnet", or "testnet") -- /squads/upgrade-check verification checks will return UNKNOWN.');
  }
  if (requireRpcNetworkMatch && solanaCluster === "mainnet-beta") {
    console.log("Strict RPC network matching is enforced for mainnet-beta.");
  }
  for (const line of evm.notes) console.log(line);
  console.log(trustProxyStartupLine(trustProxy));
  if (config.explainer) {
    console.log(`Nemotron reviewer assist enabled (model ${config.explainer.model}, advisory only).`);
  } else {
    console.log("NEBIUS_API_KEY not set -- reviews will not include an AI-generated note.");
  }
  if (requireApiKeys) {
    console.log("REQUIRE_API_KEYS=true -- transaction endpoints reject requests without a customer API key (onboard customers with scripts/customers.mjs).");
  } else {
    console.log("Open mode until the first customer is created with scripts/customers.mjs: then every transaction endpoint requires that customer's API key. Set REQUIRE_API_KEYS=true to require keys from the start.");
  }
  if (requireReviewers) {
    console.log("REVIEW_REQUIRE_REVIEWERS=true -- only named reviewer tokens can approve or deny (add them with scripts/reviewers.mjs).");
  } else if (!config.reviewActionSecret) {
    console.log("REVIEW_ACTION_SECRET not set -- approve/deny works only for named reviewers (scripts/reviewers.mjs); with none registered, actions are disabled.");
  } else {
    console.log("REVIEW_ACTION_SECRET is enabled -- resolutions made with it are not attributable to a person. Set REVIEW_REQUIRE_REVIEWERS=true once reviewers are registered.");
  }
  });
}

void start();
