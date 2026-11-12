import { Connection, type PublicKey } from "@solana/web3.js";
import { withLookupTimeout, type LookupTableResolver } from "../agent-integration/parse-transaction.js";
import { trustProxyStartupLine } from "../api/trust-proxy.js";
import { CustomerStore } from "../customers/customer-store.js";
import { endpointLabel } from "../network/endpoint-label.js";
import { sandboxRuntimeConfig } from "./config.js";
import { ENGINE } from "../check/engine.js";
import { createSandboxServer } from "./server.js";

const runtime = sandboxRuntimeConfig(process.env);
const { port, requestsPerMinute, trustProxy } = runtime;
const rpcUrl = process.env.SANDBOX_RPC_URL;
const customers = runtime.requireApiKeys || runtime.persistencePath ? new CustomerStore({ persistencePath: runtime.persistencePath }) : undefined;

// Optional. Without it, a transaction that uses a lookup table the request does not supply is held.
let resolveLookupTable: LookupTableResolver | undefined;
if (rpcUrl) {
  const connection = new Connection(rpcUrl, "confirmed");
  resolveLookupTable = withLookupTimeout(async (address: PublicKey) => {
    try { return (await connection.getAddressLookupTable(address)).value; }
    catch { console.error("Failed to resolve address lookup table."); return null; }
  });
}

// Railway sets RAILWAY_GIT_COMMIT_SHA; elsewhere set SOURCE_COMMIT at deploy time.
const sourceCommit = process.env.SOURCE_COMMIT ?? process.env.RAILWAY_GIT_COMMIT_SHA;

createSandboxServer({ customers, requireApiKeys: runtime.requireApiKeys, persistencePath: runtime.persistencePath, resolveLookupTable, trustProxy, sourceCommit, repositoryUrl: process.env.SANDBOX_REPOSITORY_URL, rateLimit: { maxRequests: requestsPerMinute, windowMs: 60_000 } }).listen(port, () => {
  console.log(`AgentGuard sandbox (${ENGINE.name} ${ENGINE.version}) on http://localhost:${port}. Signs nothing and does not store requests.`);
  console.log(runtime.requireApiKeys ? "Customer API keys required for policy checks." : "Local preview mode; do not expose without access controls.");
  console.log(rpcUrl ? `Lookup table RPC: ${endpointLabel(rpcUrl)}.` : "No SANDBOX_RPC_URL: lookup tables must be supplied in the request.");
  console.log(trustProxyStartupLine(trustProxy));
});
