import { PublicKey } from "@solana/web3.js";
import { turnkeyHttpApi, type TurnkeyApi } from "./api.js";
import type { GuardedWallet } from "./approver.js";

/**
 * Reads the Turnkey approver settings. All of TURNKEY_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY,
 * TURNKEY_API_PRIVATE_KEY and TURNKEY_WALLETS, or none of them:
 *   TURNKEY_WALLETS  JSON object of Solana wallet address -> {"policyId": "...", "agentId": "...", "customerId"?: "..."}
 *   TURNKEY_API_BASE_URL (default https://api.turnkey.com), TURNKEY_POLL_MS (default 3000)
 */
export function turnkeyConfigFromEnv(env: NodeJS.ProcessEnv): { api: TurnkeyApi; wallets: Record<string, GuardedWallet>; pollMs?: number } | undefined {
  const names = ["TURNKEY_ORGANIZATION_ID", "TURNKEY_API_PUBLIC_KEY", "TURNKEY_API_PRIVATE_KEY", "TURNKEY_WALLETS"] as const;
  const set = names.filter((name) => env[name]);
  if (set.length === 0) return undefined;
  if (set.length !== names.length) throw new Error(`Turnkey approval needs all of ${names.join(", ")}; missing ${names.filter((name) => !env[name]).join(", ")}.`);

  let parsed: unknown;
  try { parsed = JSON.parse(env.TURNKEY_WALLETS!); } catch { throw new Error("TURNKEY_WALLETS must be a JSON object."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || Object.keys(parsed).length === 0) throw new Error("TURNKEY_WALLETS must name at least one wallet.");
  const wallets: Record<string, GuardedWallet> = {};
  for (const [address, entry] of Object.entries(parsed as Record<string, unknown>)) {
    try { new PublicKey(address); } catch { throw new Error(`TURNKEY_WALLETS has an invalid Solana address "${address}".`); }
    const e = entry as Record<string, unknown>;
    if (typeof e?.policyId !== "string" || typeof e.agentId !== "string" || (e.customerId !== undefined && typeof e.customerId !== "string")) {
      throw new Error(`TURNKEY_WALLETS entry for ${address} must be {"policyId": string, "agentId": string, "customerId"?: string}.`);
    }
    if (e.customerId !== undefined && (e.customerId as string).trim().length === 0) {
      throw new Error(`TURNKEY_WALLETS entry for ${address} has an empty customerId; omit it only for an intentionally unscoped wallet.`);
    }
    wallets[address] = { policyId: e.policyId, agentId: e.agentId, ...(e.customerId !== undefined ? { customerId: e.customerId as string } : {}) };
  }
  const pollMs = env.TURNKEY_POLL_MS === undefined ? undefined : Number(env.TURNKEY_POLL_MS);
  if (pollMs !== undefined && (!Number.isSafeInteger(pollMs) || pollMs < 500)) throw new Error("TURNKEY_POLL_MS must be a whole number of milliseconds, at least 500.");
  const api = turnkeyHttpApi({ organizationId: env.TURNKEY_ORGANIZATION_ID!, apiPublicKey: env.TURNKEY_API_PUBLIC_KEY!, apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY!, baseUrl: env.TURNKEY_API_BASE_URL });
  return { api, wallets, ...(pollMs !== undefined ? { pollMs } : {}) };
}
