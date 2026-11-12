// Onboard and manage customers directly in the AgentGuard SQLite file. Run `npm run build` first.
//
//   node scripts/customers.mjs add "Acme Treasury" [--rate 120]   creates the customer and prints its first API key ONCE
//   node scripts/customers.mjs key <customer-id>                  issues another key (rotation)
//   node scripts/customers.mjs revoke-key <key-id>
//   node scripts/customers.mjs revoke <customer-id>               stops all of that customer's keys; history is kept
//   node scripts/customers.mjs set-webhook <customer-id> <slack-webhook-url|none>   where this customer's escalations go
//   node scripts/customers.mjs list
//   node scripts/customers.mjs policy-example                     prints a policy template
//   node scripts/customers.mjs policy-set <customer-id> <policy.json>
//   node scripts/customers.mjs policy-list <customer-id>
//
// AGENTGUARD_DB_PATH picks the database (default ./agentguard.sqlite). A running server picks changes
// up immediately. There is deliberately no HTTP endpoint for this: whoever can run it already has shell
// access to the database. Creating the first customer switches the server from open mode to
// requiring an API key on every transaction endpoint.
import { readFileSync } from "node:fs";
import { CustomerStore } from "../dist/src/customers/customer-store.js";

const [command, ...rest] = process.argv.slice(2);
const store = new CustomerStore({ persistencePath: process.env.AGENTGUARD_DB_PATH ?? "agentguard.sqlite" });
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i === -1 ? undefined : rest[i + 1]; };

try {
  if (command === "add" && rest[0]) {
    const customer = store.create(rest[0], flag("rate") ? Number(flag("rate")) : undefined);
    const { keyId, apiKey } = store.issueKey(customer.id);
    console.log(`Customer: ${customer.name}\nId:       ${customer.id}\nRate:     ${customer.rateLimitPerMinute} requests per window\nKey id:   ${keyId}\nAPI key:  ${apiKey}\n`);
    console.log("Give the key to the customer over a private channel. It is not stored and cannot be shown again.");
    console.log("Next: write their policy and load it with `policy-set` (run `policy-example` for a template).");
  } else if (command === "key" && rest[0]) {
    const { keyId, apiKey } = store.issueKey(rest[0]);
    console.log(`Key id:  ${keyId}\nAPI key: ${apiKey}\n\nShown once. Revoke the old key with revoke-key once the customer has switched.`);
  } else if (command === "revoke-key" && rest[0]) {
    console.log(store.revokeKey(rest[0]) ? "Revoked." : "No active key with that id.");
  } else if (command === "revoke" && rest[0]) {
    console.log(store.revoke(rest[0]) ? "Revoked." : "No active customer with that id.");
  } else if (command === "set-webhook" && rest[0] && rest[1]) {
    console.log(store.setSlackWebhook(rest[0], rest[1] === "none" ? undefined : rest[1]) ? "Updated." : "No such customer.");
  } else if (command === "list") {
    for (const c of store.list()) {
      console.log(`${c.id}  ${c.name}  rate ${c.rateLimitPerMinute}  created ${c.createdAt}${c.revokedAt ? `  REVOKED ${c.revokedAt}` : ""}`);
      for (const k of store.listKeys(c.id)) console.log(`    key ${k.id}  created ${k.createdAt}${k.revokedAt ? `  REVOKED ${k.revokedAt}` : ""}`);
      for (const p of store.listPolicies(c.id)) console.log(`    policy ${p.policyId}`);
    }
  } else if (command === "policy-example") {
    console.log(JSON.stringify({
      policyId: "acme-treasury-payments",
      programAllowlist: ["11111111111111111111111111111111"],
      destinationAllowlist: [], allowAnyDestination: true,
      maxAmountPerTransaction: { native: "1000000000" },
      maxAmountPerDay: { native: "5000000000" },
      maxPriorityFeePerTransaction: "10000"
    }, null, 2));
    console.error("\n// Amounts are base units as strings (lamports for 'native'). This example permits any destination because allowAnyDestination is true. An empty destinationAllowlist without that opt-in requires review.");
  } else if (command === "policy-set" && rest[0] && rest[1]) {
    const policy = store.setPolicy(rest[0], JSON.parse(readFileSync(rest[1], "utf8")));
    console.log(`Stored policy ${policy.policyId}. The customer sends "policyId": "${policy.policyId}" in each request.`);
  } else if (command === "policy-list" && rest[0]) {
    for (const p of store.listPolicies(rest[0])) console.log(JSON.stringify(p, null, 2));
  } else {
    console.error('Usage: node scripts/customers.mjs add "<name>" [--rate N] | key <id> | revoke-key <key-id> | revoke <id> | set-webhook <id> <url|none> | list | policy-example | policy-set <id> <file> | policy-list <id>');
    process.exit(1);
  }
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exit(1);
}
