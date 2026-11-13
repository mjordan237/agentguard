import { parseTrustProxy } from "../api/trust-proxy.js";

type Environment = Record<string, string | undefined>;

function flag(env: Environment, name: string): boolean {
  const value = env[name];
  if (value !== undefined && value !== "true" && value !== "false") throw new Error(`${name} must be exactly true or false.`);
  return value === "true";
}

export function sandboxRuntimeConfig(env: Environment) {
  const production = flag(env, "AGENTGUARD_PRODUCTION");
  const requireApiKeys = flag(env, "REQUIRE_API_KEYS");
  const port = Number(env.PORT ?? 8788);
  const requestsPerMinute = Number(env.SANDBOX_REQUESTS_PER_MINUTE ?? 60);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer from 0 to 65535.");
  if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute <= 0) throw new Error("SANDBOX_REQUESTS_PER_MINUTE must be a positive integer.");
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  const clientIpHeader = env.CLIENT_IP_HEADER;
  if (clientIpHeader !== undefined && clientIpHeader !== "x-real-ip") throw new Error("CLIENT_IP_HEADER must be x-real-ip or unset.");
  if (clientIpHeader && trustProxy !== 1) throw new Error("CLIENT_IP_HEADER requires TRUST_PROXY=1 and an edge that overwrites X-Real-IP.");
  let baseUrl: URL | undefined;
  if (env.BASE_URL) {
    try { baseUrl = new URL(env.BASE_URL); } catch { throw new Error("BASE_URL must be a valid URL."); }
    if (!["http:", "https:"].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
      throw new Error("BASE_URL must be an HTTP(S) URL without credentials, query or fragment.");
    }
  }
  if (production) {
    if (!requireApiKeys) throw new Error("Production policy API requires REQUIRE_API_KEYS=true.");
    if (!env.AGENTGUARD_DB_PATH || env.AGENTGUARD_DB_PATH === ":memory:") throw new Error("Production policy API requires a persistent AGENTGUARD_DB_PATH.");
    if (env.TRUST_PROXY === undefined || env.TRUST_PROXY === "") throw new Error("Production policy API requires explicit TRUST_PROXY.");
    if (!baseUrl || baseUrl.protocol !== "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname)) {
      throw new Error("Production policy API requires a public HTTPS BASE_URL.");
    }
  }
  return { production, requireApiKeys, port, requestsPerMinute, trustProxy, clientIpHeader: clientIpHeader === "x-real-ip" ? "x-real-ip" as const : undefined, persistencePath: env.AGENTGUARD_DB_PATH, baseUrl: baseUrl?.origin };
}
