import { LocalKeySigner, type EvmSigner } from "./sign.js";
import { rpcCodeLookup, type CodeLookup } from "./code-check.js";
import { rpcBroadcaster, type EvmBroadcaster } from "./broadcast.js";

export interface EvmEnvConfig {
  evmSigner?: EvmSigner;
  evmCodeLookup?: CodeLookup;
  evmBroadcaster?: EvmBroadcaster;
  /** One line per decision, safe to print: addresses and switches, never key material. */
  notes: string[];
}

const flag = (env: NodeJS.ProcessEnv, name: string): boolean => {
  const value = env[name];
  if (value !== undefined && value !== "true" && value !== "false") throw new Error(`${name} must be exactly true or false when set.`);
  return value === "true";
};

/**
 * Reads the EVM options from environment variables. Everything is off unless asked for:
 *  - EVM_RPC_URLS    JSON object of chain id -> http(s) RPC URL, e.g. {"1":"https://..."}. Turns on the code check.
 *  - EVM_BROADCAST   "true" also lets /gate-and-sign-evm broadcast (needs EVM_RPC_URLS).
 *  - EVM_LOCAL_KEY_HEX + EVM_ALLOW_LOCAL_KEY=true   a signing key held in this process. For tests and supervised
 *    pilots only: refused when production is on, and refused without the explicit allow flag.
 */
export function evmConfigFromEnv(env: NodeJS.ProcessEnv, production: boolean): EvmEnvConfig {
  const out: EvmEnvConfig = { notes: [] };

  let urls: Record<number, string> | undefined;
  if (env.EVM_RPC_URLS !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.EVM_RPC_URLS); } catch { throw new Error('EVM_RPC_URLS must be a JSON object such as {"1":"https://..."}.'); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length === 0) throw new Error("EVM_RPC_URLS must be a non-empty JSON object of chain id to URL.");
    urls = {};
    for (const [chain, url] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^[1-9]\d*$/.test(chain)) throw new Error(`EVM_RPC_URLS has an invalid chain id "${chain}".`);
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error(`EVM_RPC_URLS entry for chain ${chain} must be an http(s) URL.`);
      urls[Number(chain)] = url;
    }
    out.evmCodeLookup = rpcCodeLookup(urls);
    out.notes.push(`EVM code check on for chains ${Object.keys(urls).join(", ")}.`);
  } else {
    out.notes.push("EVM_RPC_URLS not set -- EVM destination code checks (EIP-7702 delegation, unlisted contracts) are off.");
  }

  if (flag(env, "EVM_BROADCAST")) {
    if (!urls) throw new Error("EVM_BROADCAST=true needs EVM_RPC_URLS.");
    out.evmBroadcaster = rpcBroadcaster(urls);
    out.notes.push("EVM broadcast mode available (broadcast:true on /gate-and-sign-evm).");
  }

  const keyHex = env.EVM_LOCAL_KEY_HEX;
  if (keyHex !== undefined) {
    if (production) throw new Error("EVM_LOCAL_KEY_HEX is refused when AGENTGUARD_PRODUCTION=true: a key held in the server's memory is not custody.");
    if (!flag(env, "EVM_ALLOW_LOCAL_KEY")) throw new Error("EVM_LOCAL_KEY_HEX needs EVM_ALLOW_LOCAL_KEY=true, to confirm this is a test or supervised pilot key.");
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error("EVM_LOCAL_KEY_HEX must be 32 bytes of hex.");
    out.evmSigner = new LocalKeySigner(Uint8Array.from(Buffer.from(keyHex.replace(/^0x/, ""), "hex")));
    out.notes.push(`EVM signer: local in-memory key for ${out.evmSigner.address} (test or supervised pilot only, not custody).`);
  } else {
    out.notes.push("No EVM signer configured -- /gate-and-sign-evm answers 503.");
  }
  return out;
}
