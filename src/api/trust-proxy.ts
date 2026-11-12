/**
 * How many reverse-proxy hops sit in front of the server, from the TRUST_PROXY environment variable.
 *
 * It matters because rate limits are keyed by client IP, including the budget for guessing review tokens.
 * Behind a proxy without this setting every client looks like the proxy and shares one budget, so a single
 * attacker can lock everyone out. With it set too loosely, a client can forge X-Forwarded-For and dodge the limits.
 * So the value is an exact hop count, never "true" (which trusts any header), and unset means the socket address.
 */
export function parseTrustProxy(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || value === "false" || value === "0") return undefined;
  if (!/^[1-9]\d?$/.test(value) || Number(value) > 10) {
    throw new Error(`TRUST_PROXY must be the number of reverse-proxy hops in front of this server (1 to 10), or unset. "true" is not accepted because it trusts any client-supplied address. Got "${value}".`);
  }
  return Number(value);
}

export function trustProxyStartupLine(hops: number | undefined): string {
  return hops === undefined
    ? "Client address: the socket's own address (TRUST_PROXY not set). Behind a reverse proxy, set TRUST_PROXY to the number of proxy hops."
    : `Client address: taken from X-Forwarded-For, trusting ${hops} proxy hop${hops === 1 ? "" : "s"} (TRUST_PROXY=${hops}).`;
}
