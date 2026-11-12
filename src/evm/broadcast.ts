/** Sends a signed transaction to the network and returns its hash. Throws if it was not accepted. */
export type EvmBroadcaster = (chainId: number, signedTransaction: string) => Promise<string>;

/** A broadcaster backed by JSON-RPC eth_sendRawTransaction, one URL per chain id, 10 s timeout, no retries. */
export function rpcBroadcaster(urls: Record<number, string>, fetchImpl: typeof fetch = fetch): EvmBroadcaster {
  return async (chainId, signedTransaction) => {
    const url = urls[chainId];
    if (!url) throw new Error(`No RPC URL is configured for chain ${chainId}.`);
    const response = await fetchImpl(url, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [signedTransaction] })
    });
    if (!response.ok) throw new Error(`The node answered HTTP ${response.status}.`);
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.result)) throw new Error(`The node did not accept the transaction${body.error?.message ? `: ${body.error.message}` : "."}`);
    return body.result.toLowerCase();
  };
}
