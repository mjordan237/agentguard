/** Shortest REVIEW_ACTION_SECRET accepted: anyone holding it can approve any review, so it must not be guessable. */
export const MIN_REVIEW_SECRET_LENGTH = 32;

/** Problems with a REVIEW_ACTION_SECRET in any mode. A weak shared secret is never acceptable, demo or not. */
export function reviewSecretProblem(secret: string | undefined): string | undefined {
  if (secret === undefined || secret === "") return undefined;
  if (secret.length < MIN_REVIEW_SECRET_LENGTH) {
    return `REVIEW_ACTION_SECRET is ${secret.length} characters; it must be at least ${MIN_REVIEW_SECRET_LENGTH} (for example: openssl rand -hex 32).`;
  }
  return undefined;
}

/**
 * The controls a production deployment must set explicitly. Each one has a default that is safe on a laptop and
 * wrong on a server: review links pointing at localhost, every client sharing the proxy's rate-limit budget.
 */
export function productionConfigProblems(env: Record<string, string | undefined>): string[] {
  const missing: string[] = [];
  if (env.REQUIRE_API_KEYS !== "true") missing.push("REQUIRE_API_KEYS=true (every request must carry a customer API key)");
  if (env.REVIEW_REQUIRE_REVIEWERS !== "true") missing.push("REVIEW_REQUIRE_REVIEWERS=true (approvals must come from a named reviewer, not a shared secret)");
  if (!env.AGENTGUARD_DB_PATH) missing.push("AGENTGUARD_DB_PATH (an explicit database location, so state is not written to a throwaway default)");
  const baseUrl = env.BASE_URL;
  if (!baseUrl) {
    missing.push("BASE_URL (the public https address; review links sent to Slack are built from it)");
  } else {
    let url: URL | undefined;
    try { url = new URL(baseUrl); } catch { /* reported below */ }
    if (!url || url.protocol !== "https:") missing.push(`BASE_URL must be an https URL (got "${baseUrl}")`);
    else if (url.hostname === "localhost" || url.hostname === "127.0.0.1") missing.push(`BASE_URL points at ${url.hostname}, so review links would not open for anyone else`);
  }
  // Unset is ambiguous on a server: it might be correct (no proxy) or a forgotten setting behind one. Say which.
  if (env.TRUST_PROXY === undefined || env.TRUST_PROXY === "") missing.push("TRUST_PROXY (the number of reverse-proxy hops in front of the server, or 0 when there is none)");
  return missing;
}
