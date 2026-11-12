// Manage named reviewers directly in the AgentGuard SQLite file. Run `npm run build` first.
//
//   node scripts/reviewers.mjs add "Alice Example"     prints the reviewer's token ONCE; acts on ANY review (operator)
//   node scripts/reviewers.mjs add "Bob" --customer <customer-id>   acts only on that customer's reviews
//   node scripts/reviewers.mjs list
//   node scripts/reviewers.mjs revoke <reviewer-id>
//
// AGENTGUARD_DB_PATH picks the database (default ./agentguard.sqlite). There is deliberately no
// HTTP endpoint for this: whoever can run this has shell access to the database already.
import { ReviewerStore } from "../dist/src/escalation/reviewer-store.js";

const [command, arg, ...rest] = process.argv.slice(2);
const customerId = rest.includes("--customer") ? rest[rest.indexOf("--customer") + 1] : undefined;
const store = new ReviewerStore({ persistencePath: process.env.AGENTGUARD_DB_PATH ?? "agentguard.sqlite" });

if (command === "add" && arg) {
  const { reviewer, token } = store.create(arg, customerId);
  console.log(`Reviewer: ${reviewer.name}${customerId ? ` (customer ${customerId} only)` : " (operator: any customer)"}\nId:       ${reviewer.id}\nToken:    ${token}\n`);
  console.log("Give the token to that person over a private channel. It is not stored and cannot be shown again.");
} else if (command === "list") {
  for (const r of store.list()) console.log(`${r.id}  ${r.name}${r.customerId ? ` [customer ${r.customerId}]` : " [operator]"}  created ${r.createdAt}${r.revokedAt ? `  REVOKED ${r.revokedAt}` : ""}`);
} else if (command === "revoke" && arg) {
  console.log(store.revoke(arg) ? "Revoked." : "No active reviewer with that id.");
} else {
  console.error('Usage: node scripts/reviewers.mjs add "<name>" | list | revoke <id>');
  process.exit(1);
}
