#!/usr/bin/env node
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { PublicKey } from "@solana/web3.js";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The Turnkey policies that put AgentGuard in front of one wallet: signing needs both the agent's user and
 * AgentGuard's user, and nobody but the root quorum may export the key. Values are checked before they are written
 * into an expression, so an input with a quote cannot rewrite the policy it is meant to restrict.
 */
export function turnkeyGuardPolicies(input: { agentUserId: string; agentGuardUserId: string; walletAddress: string; label: string }) {
  if (!USER_ID.test(input.agentUserId)) throw new Error("agentUserId must be a Turnkey user id (a UUID).");
  if (!USER_ID.test(input.agentGuardUserId)) throw new Error("agentGuardUserId must be a Turnkey user id (a UUID).");
  if (input.agentUserId === input.agentGuardUserId) throw new Error("The agent and AgentGuard must be different Turnkey users, or one approval would count as both.");
  try { if (new PublicKey(input.walletAddress).toBase58() !== input.walletAddress) throw new Error(); } catch { throw new Error("walletAddress must be a base58 Solana address."); }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.label)) throw new Error("label must be lowercase letters, digits and dashes.");
  return [
    {
      policyName: `agentguard:${input.label}:sign`,
      effect: "EFFECT_ALLOW",
      consensus: `approvers.any(user, user.id == '${input.agentUserId}') && approvers.any(user, user.id == '${input.agentGuardUserId}')`,
      // The exact version on purpose: a future version is denied by Turnkey instead of reaching an approver that cannot read it.
      condition: `activity.type == 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' && wallet_account.address == '${input.walletAddress}'`,
      notes: "Signing for this wallet needs the agent and AgentGuard. AgentGuard approves only what passes its checks or a person approves."
    },
    {
      policyName: `agentguard:${input.label}:no-export`,
      effect: "EFFECT_DENY",
      consensus: "true",
      // Parentheses matter: Turnkey gives && and || the same precedence.
      condition: "(activity.resource == 'WALLET' || activity.resource == 'PRIVATE_KEY') && activity.action == 'EXPORT'",
      notes: "Nobody but the root quorum may export this organization's wallets or private keys."
    }
  ];
}

const USAGE = `Prints the Turnkey policies that require AgentGuard's approval for one wallet.

  turnkey-policy --agent-user <uuid> --agentguard-user <uuid> --wallet <address> --label <name>

Before relying on them: the agent's user must not be in the root quorum (root users skip policies), and no other
policy may let the agent sign for this wallet alone.`;

async function main() {
  const { values } = parseArgs({ options: { "agent-user": { type: "string" }, "agentguard-user": { type: "string" }, wallet: { type: "string" }, label: { type: "string" }, help: { type: "boolean" } } });
  if (values.help || !values["agent-user"] || !values["agentguard-user"] || !values.wallet || !values.label) { console.log(USAGE); process.exit(values.help ? 0 : 1); }
  try {
    console.log(JSON.stringify(turnkeyGuardPolicies({ agentUserId: values["agent-user"], agentGuardUserId: values["agentguard-user"], walletAddress: values.wallet, label: values.label }), null, 2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
