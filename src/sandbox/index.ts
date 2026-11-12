import { Connection, type PublicKey } from "@solana/web3.js";
import { withLookupTimeout, type LookupTableResolver } from "../agent-integration/parse-transaction.js";
import { parseTrustProxy, trustProxyStartupLine } from "../api/trust-proxy.js";
import { ENGINE } from "../check/engine.js";
import { createSandboxServer } from "./server.js";

const port = Number(process.env.PORT ?? 8788);
const rpcUrl = process.env.SANDBOX_RPC_URL;
const requestsPerMinute = Number(process.env.SANDBOX_REQUESTS_PER_MINUTE ?? 60);
if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute <= 0) throw new Error("SANDBOX_REQUESTS_PER_MINUTE must be a positive whole number.");
const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);

// Optional. Without it, a transaction that uses a lookup table the request does not supply is held.
let resolveLookupTable: LookupTableResolver | undefined;
if (rpcUrl) {
  const connection = new Connection(rpcUrl, "confirmed");
  resolveLookupTable = withLookupTimeout(async (address: PublicKey) => {
    try { return (await connection.getAddressLookupTable(address)).value; }
    catch (error) { console.error(`Failed to resolve address lookup table ${address.toBase58()}:`, (error as Error).message); return null; }
  });
}

// Railway sets RAILWAY_GIT_COMMIT_SHA; elsewhere set SOURCE_COMMIT at deploy time.
const sourceCommit = process.env.SOURCE_COMMIT ?? process.env.RAILWAY_GIT_COMMIT_SHA;

createSandboxServer({ resolveLookupTable, trustProxy, sourceCommit, repositoryUrl: process.env.SANDBOX_REPOSITORY_URL, rateLimit: { maxRequests: requestsPerMinute, windowMs: 60_000 } }).listen(port, () => {
  console.log(`AgentGuard sandbox (${ENGINE.name} ${ENGINE.version}) on http://localhost:${port}. Signs nothing and does not store requests.`);
  console.log(rpcUrl ? `Lookup tables not in a request are read from ${new URL(rpcUrl).host}.` : "No SANDBOX_RPC_URL: lookup tables must be supplied in the request.");
  console.log(trustProxyStartupLine(trustProxy));
});
