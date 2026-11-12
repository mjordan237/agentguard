# Integration and operations reference

[Back to the project overview](../README.md). This reference describes the
implementation and configuration. It does not establish the state of any hosted deployment.

## Optional reviewer explanations

When the policy engine escalates a transaction (`NEEDS_REVIEW`), AgentGuard
asks an NVIDIA Nemotron model served by **Nebius Token Factory** to write a
short plain-English note for the human reviewer: what the instructions do and
what to double-check. The note appears on the review page and in the Slack
message, labeled "AI-generated, advisory only", with the model id.

Where it runs: `src/analysis/nemotron-explainer.ts` makes a runtime call to
Token Factory's OpenAI-compatible `/chat/completions` endpoint.

What it can and cannot do, enforced by tests in `test/nemotron-explainer.test.ts`:

- **Advisory only.** `evaluatePolicy` has already decided before the model is
  called. The decision is identical with the assist off, on, failing, or
  returning hostile output.
- **Transaction text is untrusted.** Memos, account labels and decoded fields
  go to the model inside a delimited data block, length-capped, with our own
  delimiters stripped from the data. The model is told not to follow
  instructions found there.
- **Output is validated and escaped.** Anything that is not the exact
  `{summary, risks}` shape is dropped; text is length-capped and HTML-escaped
  on the review page and Slack-escaped in Slack.
- **Asynchronous.** The `/evaluate` response does not wait on the model. A
  missing key, timeout, non-200 or malformed reply simply means no note.
- **Explanation-service error logging.** Errors log the HTTP status or error name only.

Configuration (all optional; unset means no AI note):

| Variable | Meaning |
|---|---|
| `NEBIUS_API_KEY` | Token Factory API key |
| `NEBIUS_MODEL` | Nemotron model id. Required if the key is set. List candidates with `NEBIUS_API_KEY=... node scripts/list-nebius-models.mjs` |
| `NEBIUS_BASE_URL` | Defaults to `https://api.tokenfactory.nebius.com/v1` |

## Customer onboarding

Run commands in this reference from the repository root.

Out of the box the server is in **open mode**: anyone who can reach it can call `/evaluate`
against the built-in demo policy. That is right for the demo and wrong for a deployment.
Creating the first customer switches it to **key mode** with no restart:

```bash
node scripts/customers.mjs add "Acme Treasury" --rate 120   # prints the customer's API key ONCE
node scripts/customers.mjs policy-example > acme.json       # edit it, then:
node scripts/customers.mjs policy-set <customer-id> acme.json
```

The customer then sends `Authorization: Bearer agk_...` (or `X-API-Key`) with each request.

- **Every transaction endpoint needs a key** once any customer exists: `/evaluate`,
  `/gate-and-sign`, `/squads/upgrade-check`, `/transactions/:id`, `/agents/:id/history`.
  `/healthz` stays open. The review pages open for anyone but show nothing until a reviewer signs in
  (see "Operator review queue" below).
- **A customer reaches only its own policies.** Another customer's policy id, the built-in
  policy and a nonexistent id all return the same 404.
- **History is per customer.** Two customers using the same `agentId` do not see each other's entries.
- **Each customer has its own rate limit** (`--rate`, requests per rate-limit window, default 120
  per minute). Requests with a bad key spend a separate per-IP budget, so guessing cannot
  starve real customers.
- **Revocation.** `revoke` stops all of a customer's keys; the server stays in key mode
  even if every customer is revoked. `key` / `revoke-key` rotate keys. Keys are stored as SHA-256 hashes.
- `REQUIRE_API_KEYS=true` demands keys from the first request, even before any customer exists.
- Policies are validated strictly (unknown fields, non-numeric amounts and bad addresses are
  rejected) and a policy id belongs to one customer. An empty `destinationAllowlist` fails closed: instructions that move value go to review unless the policy sets `allowAnyDestination: true`.

**Reviewers and Slack are per customer.** `node scripts/reviewers.mjs add "Bob" --customer <customer-id>`
creates a reviewer who can approve or deny only that customer's reviews; for anyone else's review they get the
same 404 as for a missing one. A reviewer added without `--customer` is an operator and can act on any review.
`node scripts/customers.mjs set-webhook <customer-id> <slack-webhook-url>` sends that customer's escalations to
its own Slack channel (only `https://hooks.slack.com/services/...` URLs are accepted); a customer without one
falls back to the server-wide `SLACK_WEBHOOK_URL`, so the operator still sees it. Set
`REVIEW_REQUIRE_REVIEWERS=true` in key mode: the legacy shared secret is not scoped to any customer.

### Operator review queue

`/operator/reviews` lists the reviews that need attention, and `/review/:id` (the link in Slack and in API
responses) shows one. Both open a sign-in page first. Sign in with a reviewer token; the page keeps it in memory
for that tab only (no cookie, no browser storage, never in the address bar or a form field) and sends it in the
`X-Reviewer-Token` header. Moving between the queue and a review inside the page keeps you signed in, and Approve
and Deny reuse the token, so you type it once per tab. A reload, a new tab or a Slack link asks again.

**Review access.** Before sign-in, `/review/:id` returns the same sign-in page, byte for byte, for any id, real or not. The review is
loaded only after sign-in, from `GET /operator/api/reviews/:id`, with the same customer scoping as the queue.
Approve and deny use the `POST /review/:id/approve` and `/deny` actions: the page calls them
with the token in a header and `Accept: application/json`, and gets an explicit answer for its own request:
`200 {"outcome":"applied"}` if this request made the decision, `409 {"outcome":"already_decided"}` if someone
else (or an earlier request) decided it first, and `410 {"outcome":"expired"}`. Only the applying request is
credited, recorded in the audit log and acted on; whether it applied comes from the same database transaction as
the change, so concurrent reviewers, even on separate server processes, cannot both get "applied". Other clients,
including older ones that post a `token` or `secret` form field, keep the original answers: a redirect to the
review, or 410 once it has expired. A server
with no reviewer and no shared secret shows no review details; the agent's own
`GET /reviews/:id` status endpoint is unchanged.

Who sees what:

- **A customer's reviewer** sees only that customer's reviews. The filter is part of the database query, and
  another customer's review answers 404 as a missing one does.
- **An operator reviewer** (added without `--customer`) sees every customer's reviews, with the customer id.
- **The shared secret**, while it is still accepted (`REVIEW_REQUIRE_REVIEWERS` unset), sees everything, as it can
  act on everything. With no reviewer and no secret, the queue is off (503), like the actions.

The same data is JSON at `GET /operator/api/reviews`, newest first, ties broken by review id:
`status` (`PENDING` by default; `APPROVED`, `DENIED`, `EXPIRED`, or `ALL`), `agent` (exact id), `chain`
(`solana`, `evm`, `evm:<chain id>`, or `unknown` for reviews stored before the chain was recorded), `limit`
(1 to 100, default 25) and `cursor` (the `nextCursor` of the previous page). Unknown or repeated parameters
are refused. `GET /operator/api/reviews/:id` gives one review with its decoded instructions and history.
Both share a per-IP rate limit. Approving and denying happen on the review page, one review at a time and after
a confirmation, through the same POST actions as before; the queue changes nothing itself.

The review page reports four things separately, each from its own record:

| Step | What it says | What it does not say |
|---|---|---|
| Policy check | Why the transaction was held | |
| Reviewer decision | Approved, denied, expired; by whom and when | |
| Approval use | Whether the approval was spent, and when | That anything was signed |
| Outcome | The Turnkey record's state, or the `signed` / `signing_failed` audit event of a `/gate-and-sign*` call that spent it; otherwise "No recorded signing outcome" | That the transaction executed on chain |

Turnkey states keep AgentGuard's vote apart from the signing request it votes on:
- **Waiting for review**.
- **Submitting vote**.
- **Vote submission pending**: Turnkey is still processing AgentGuard's vote activity.
- **Vote completed**: AgentGuard's vote activity completed. Not proof of signing or execution. The signing request
  may still need other approvers, so it keeps being read (never voted on again) until Turnkey finishes it or 7 days
  pass.
- **Original signing request completed**: Turnkey reports the signing request itself completed, by AgentGuard's
  vote or another approver's. Not proof of execution on chain.
- **Outcome unknown**.
- **Vote refused**: the signing request is still read, as above.
- **Rejected**.
- **Resolved in Turnkey**: rejected or failed without AgentGuard deciding it.
- **Mismatch, rejected**: the request or the wallet's assignment changed.
- **Signing outcome not observed**: 7 days passed after AgentGuard stopped voting, and Turnkey still had not finished
  the signing request. An operator checks it in Turnkey.

Wherever a charge is still counted without proof of a signature, the page adds "Accounting retained pending
reconciliation". Stable codes such as `ASSIGNMENT_CHANGED` or `APPROVAL_STALE` are shown with a short
meaning; free-text diagnostics are only in the authenticated detail API. The page also says whether the policy's
current rules still match the reviewed revision. Free-text Turnkey diagnostics, which can name another
customer's assignment after a wallet is reassigned, go only to operator reviewers and the shared secret; a
customer's reviewer sees the stable code.

The summary names what each instruction does, from an explicit table over the decoders' output
(`src/policy/operation.ts`): transfers, ERC-20 approvals and allowance increases, revocations (`approve` of 0, a
DAI permit with `allowed: false`), NFT operator grants and removals (`setApprovalForAll`), signed permits
(EIP-2612, DAI, Permit2), Uniswap and Jupiter swaps, and WETH wrapping and unwrapping. An approval is never called
a payment: the policy engine still counts its allowance against the limits, but the page says "Approval: lets X
spend up to N". An allowance at the type's maximum (2^256-1, or 2^160-1 for Permit2), or a DAI permit with
`allowed: true`, is shown as **Unlimited approval** and flagged in the queue. Anything else is named by its
instruction or listed as not decoded. Amounts are base units; a transaction with several transfers is summarised
per asset ("3 transfers across 2 assets"), never as one total or one recipient.

Upgrading adds a nullable `chain` column to reviews and indexes for the queue, the Turnkey review link and the
audit trail's signing events. The migration runs on startup and is idempotent. Old reviews keep no chain ("unknown"); nothing
already stored is rewritten.

Not covered yet: the AI note on the review page is generated by the one server-wide Nebius key. Customers are managed from the command line on
the host; there is no self-service signup, billing, or usage reporting.

## Integrating an agent

```
agent builds + signs its transaction
  POST /gate-and-sign {agentId, policyId, transactionBase64}          (Authorization: Bearer agk_...)
    -> ALLOW         200 {decision:"ALLOW", kora:{signature,...}}      signed and submitted through Kora
    -> NEEDS_REVIEW  200 {decision:"NEEDS_REVIEW", reasons, reviewId, reviewUrl}
                         a human is notified (Slack / review page)
  GET /reviews/<reviewId>                                              poll: {status: PENDING|APPROVED|DENIED|EXPIRED, resolvedBy, used}
  once APPROVED, send the SAME transaction again:
  POST /gate-and-sign {agentId, policyId, transactionBase64, reviewId}
    -> 200 signed and submitted
```

`POST /evaluate` takes the same request and only decides (no signing), for callers that sign elsewhere.

### TypeScript client

`src/client/index.ts` is a dependency-free client (platform `fetch`, Node 18+) for the calls above. It is not
published to npm yet; build the repo and import `dist/src/client/index.js`.

```ts
import { AgentGuardClient } from "./dist/src/client/index.js";

const guard = new AgentGuardClient({ baseUrl: "https://agentguard.example.com", apiKey: process.env.AGENTGUARD_API_KEY });
const result = await guard.signWithApproval({ agentId: "invoice-bot", policyId: "acme-pay", transactionBase64 }, { timeoutMs: 120_000 });
// result.outcome: "signed" | "denied" | "expired" | "timeout"
```

`signWithApproval` tries to sign; if a person must decide it waits (polling, never forever); if they approve it signs
the same transaction with that approval. The pieces are also available alone: `evaluate`, `gateAndSign`,
`getReview`, `waitForReview`. Errors are `AgentGuardError` with `status`, `code` and `outcomeUnknown`. **It never
retries by itself:** when `outcomeUnknown` is true the transaction may already be on chain, so check it before
resubmitting. The API key is sent only in the `Authorization` header and is never put in an error. A runnable
example is in `examples/pay-a-vendor.ts`.

An approval is deliberately narrow:

- **It covers one transaction.** The review records a hash of the transaction message when it is
  created; presenting a different transaction with that `reviewId` is rejected (400 `REVIEW_MISMATCH`).
  Signatures are not part of the hash, so the agent can sign after the review.
- **It covers one agent and one revision of one policy.** The review records the agent, the policy id and a
  fingerprint of the policy's rules: SHA-256 over the validated policy in canonical JSON. Key order does not
  matter; array order does, so reordering an allowlist counts as a change. Presenting the review for another
  agent or another policy is rejected (400 `REVIEW_MISMATCH`). If the policy's rules have changed since the
  review opened, it is rejected with 409 `REVIEW_POLICY_CHANGED`, and the transaction must be sent again without
  `reviewId` for a new review. The fingerprint is returned with `NEEDS_REVIEW` (`policyFingerprint`), shown by
  `GET /reviews/<id>` and the review page, and written to the audit log. Upgrading adds the column to an existing
  database in place, and running the upgrade again is harmless. Reviews stored before the upgrade can still be
  read, but they have no fingerprint, so using one to sign is refused (`REVIEW_POLICY_CHANGED`) and the
  transaction has to be reviewed again.
- **It is single use.** The approval is spent atomically before signing, so concurrent requests cannot both consume the same approval. A failure confirmed as not submitted can release the approval. An uncertain signing
  outcome retains the approval and budget; reconcile it before retrying.
- **It expires.** It is usable for one review window (`REVIEW_EXPIRY_MS`, default 15 minutes) after approval.
- **It belongs to the customer.** Another customer's `reviewId` looks like a missing one (404).
- **It counts toward the daily spend cap**, like an ALLOW.
- Errors: 404 `REVIEW_NOT_FOUND`, 409 `REVIEW_NOT_APPROVED` / `REVIEW_ALREADY_USED` / `REVIEW_STALE`.

The status endpoint returns decision metadata only, never the transaction. An unexpected server error returns
a generic 500 (`INTERNAL_ERROR`). An HTTP error alone is not proof that an external signing request was never sent.

## Running it in production

Set `AGENTGUARD_PRODUCTION=true` and the server refuses to start unless `REQUIRE_API_KEYS=true`,
`REVIEW_REQUIRE_REVIEWERS=true`, an explicit `AGENTGUARD_DB_PATH`, an https `BASE_URL` that is not localhost
(review links in Slack are built from it) and an explicit `TRUST_PROXY` (`0` when no proxy sits in front) are
all set, and it serves customers' own policies only (the built-in demo policy is not loaded). A typo such as `AGENTGUARD_PRODUCTION=yes` is an error,
not "off". Without it the server stays in the open demo mode described above. In any mode a
`REVIEW_ACTION_SECRET` shorter than 32 characters stops the server from starting (`openssl rand -hex 32` makes one).

**Behind a reverse proxy, set `TRUST_PROXY`.** Rate limits, including the budget for guessing review tokens, are
keyed by client address. By default that is the socket's own address and `X-Forwarded-For` is ignored, so a
client cannot forge it. If a proxy or load balancer sits in front, every client then looks like the proxy and
shares one budget: one attacker's failed logins or token guesses can lock everyone else out. Set
`TRUST_PROXY` to the exact number of proxy hops (for example `TRUST_PROXY=1` behind one load balancer). Only a
whole number from 1 to 10 is accepted; `true` is refused because it would trust any address a client sends.
The server logs which mode it is in at startup, and warns once if it sees `X-Forwarded-For` while the setting is off.

**Audit trail.** Every customer has an append-only record of what happened to their requests: `evaluated`
(with the decision and reasons), `review_opened`, `review_resolved` (approved or denied, and by which named
reviewer), `approval_refused` (a reused, mismatched or expired approval), `signed` (with the signature, the
transaction hash and the approval it spent) and `signing_failed` (with whether the outcome is `UNKNOWN` or the
transaction was `NOT_SENT`). Read it with `GET /audit?after=<n>&limit=<1-1000>` using the customer's API key; a
customer only ever sees their own events. Events carry no API keys, reviewer tokens or full transactions.

Each event's hash covers the one before it, and `GET /audit/verify` recomputes the whole chain and says where
it breaks. The SQLite table also refuses `UPDATE` and `DELETE` through database triggers, and retention never
touches it. Know what this does not give you: someone who can rewrite the whole database file can recompute
every hash, and deleting events from the very end leaves a valid, shorter chain. To catch that, store the
`headHash` that `/audit/verify` returns somewhere the database's owner cannot write, and compare it later.
If an audit write fails before an action, the request fails and nothing is signed. If it fails after a signature
exists, the signature is still returned and the lost event is printed to the error log in full, so it can be
recovered. There is no pruning: plan for the table to grow, and archive it if you need to.

**Backups.** Everything lives in the one SQLite file at `AGENTGUARD_DB_PATH`: customers and policies, review
history, daily spend and the audit trail. Take a consistent copy while the server is running with

```
npm run backup -- --out backups/agentguard-$(date +%F).sqlite
```

It never changes the source and never overwrites an existing file. It then checks the copy: SQLite's integrity
check, a row count per table, and every customer's audit chain, and it prints each chain's head hash (store
those somewhere the database's owner cannot write; see the audit trail above). It exits 0 only if the copy was
written and every check passed. If a check fails the copy is kept, because a damaged database or a broken chain
is evidence, and the command says so and exits 1. Run it from cron or a scheduler and alert on a non-zero exit,
and copy the files off the machine: a backup on the same disk is not a backup. Treat copies as sensitive.

To restore: stop the server, put the copy at `AGENTGUARD_DB_PATH`, delete any `-wal` and `-shm` files left
beside the old database, start the server, and check `GET /audit/verify` against the head hash you recorded.
Backups need Node 22.19 or newer (the version tested here).

**The gate only protects what goes through it.** AgentGuard cannot stop an agent that can reach another way
to sign. Protection comes from the deployment: the relayer or multisig key that adds the final signature must
be reachable only through `/gate-and-sign`, and the agent must hold no key that can move funds on its own.
The relayer only pays fees: `/gate-and-sign` refuses, before Kora is called, any transaction in which an
instruction names the fee payer,.
Before onboarding a customer, check that (a) the agent's own key cannot submit a transaction without the
relayer's signature, (b) the relayer is not exposed to the agent except via this service, and (c) a test
transaction sent around the gate fails. These are deployment requirements; the repository alone cannot establish them.

**Decoder coverage.** The registry loaded by the entrypoint covers System transfers, SPL Token and Token-2022
`TransferChecked`, `closeAccount` and `syncNative`, ComputeBudget, and exact-in Jupiter v6 swaps (see
"Swaps (Jupiter)" below). Anything else (other token instructions, other programs) is not decoded and goes to review. Token payments are limited by mint: put the mint address
in `maxAmountPerTransaction` and `maxAmountPerDay`. A token with no configured limit goes to review, as does a
value-moving asset of any kind with no limit. The destination of a token payment is the receiving token
account, not its owner, so a destination allowlist lists token accounts.

**Priority fees.** A fee set through ComputeBudget (legacy and v0) or the message config (v1) is computed and
compared with `maxPriorityFeePerTransaction`; with no limit set any non-zero fee goes to review. The comparison utility is `scripts/verify-priority-fee.mjs`; a historical sample does not establish coverage of all transactions. A transaction made only of compute settings goes to review.

**Spend accounting.** `/evaluate` is a preview and spends nothing; pass `"reserve": true` to charge the
daily budget when you sign somewhere else. `/gate-and-sign` reserves the budget. If signing fails before
anything is sent (a fee-payer mismatch, or a simulation Kora refused) the reservation is refunded to the day it was made. If it fails in
any other way the transaction may have been broadcast, so the response says `outcome: "UNKNOWN"` and the
budget stays reserved until that day ends: over-counting is safe, refunding money that may have moved is not.
There is no automatic reconciliation against chain status yet.

## Human review on Solana needs a durable nonce

An approval is bound to the exact transaction. A recent blockhash can expire while a
transaction waits for review. Use a durable nonce for a Solana payment that may wait
for a person, and verify that the configured relayer supports durable transactions.

How the agent builds one:

1. Once, create a nonce account whose authority is the agent (`SystemProgram.createNonceAccount`). The authority
   must not be the relayer: `/gate-and-sign` refuses any instruction that names the fee payer.
2. For each payment, read the nonce's current value (`connection.getNonce(nonceAccount)`), use it as
   `recentBlockhash`, and put `SystemProgram.nonceAdvance({ noncePubkey, authorizedPubkey: agent })` first.
3. Send it to `/gate-and-sign` as usual. If it goes to review, keep the same bytes and resend them with
   `reviewId` once approved.

AgentGuard decodes the advance (it must be first, use the RecentBlockhashes sysvar and have three accounts) and
sends a transaction that only advances a nonce, or advances one anywhere but first, to review. Kora must be
started with `allow_durable_transactions = true` under `[validation]` (accepted by Kora 2.0.5). Kora warns that a
durable transaction can be held and used later; on AgentGuard's side an approval expires with its review, and
an ALLOWed transaction is signed and sent at once.

If Kora refuses a transaction because its simulation failed (an expired blockhash, an empty account), nothing
was sent: the response is `KORA_SIMULATION_FAILED` with `outcome: "NOT_SENT"` and the budget is given back.

## Turnkey wallets: AgentGuard as a required approver

For an agent whose wallet lives in Turnkey, AgentGuard does not need to hold or relay anything. The customer adds a
Turnkey policy that needs two approvers to sign for the wallet: the agent's Turnkey user and AgentGuard's. Turnkey
denies anything no policy allows, so the agent's signing request waits in `ACTIVITY_STATUS_CONSENSUS_NEEDED` until
AgentGuard votes. AgentGuard reads the exact unsigned transaction from Turnkey's API, runs the same decode, policy
check and swap simulation as `/gate-and-sign`, and approves; or opens a review and approves or rejects when the
reviewer decides. Any other request on a guarded wallet, such as Turnkey sending a transaction itself, is rejected.

```
npm run turnkey-policy -- --agent-user <agent's user id> --agentguard-user <AgentGuard's user id> \
  --wallet <Solana address> --label <name>
```

prints the two policies to install: the two-approver signing rule, and a deny on exporting wallets or keys.
Settings: `TURNKEY_ORGANIZATION_ID`, `TURNKEY_API_PUBLIC_KEY` and `TURNKEY_API_PRIVATE_KEY` (AgentGuard's own
P-256 API key, held only by this server), `TURNKEY_WALLETS` (JSON: wallet address to
`{"policyId", "agentId", "customerId"?}`), and optionally `TURNKEY_POLL_MS` (default 3000) and
`TURNKEY_API_BASE_URL`. AgentGuard polls for waiting requests; point a Turnkey `ACTIVITY_UPDATES` webhook at
`POST /turnkey/webhook` to make it react at once. The webhook body is never read, only used as a nudge to poll,
because every request is fetched from Turnkey's authenticated API before it is judged.

What has to be true for this to protect anything: the agent's Turnkey user is not in the root quorum (root users
skip policies), no other policy lets the agent sign that wallet alone, and AgentGuard's API key exists only here.
A transaction that may wait for a person should use a durable nonce. Not yet run against a real Turnkey
organization: the request signing is checked against an independent P-256 verifier, and the flow against a
stand-in Turnkey API.

**Deployment boundary.** Run one active Turnkey approver process. The shared SQLite lease and fence detect
tested takeover cases, but they do not provide complete multi-replica or exactly-once submission safety.
An external vote request already in flight can finish after a takeover; a sufficiently delayed request can
outlive the replay window. Before replacing an active process, stop it and reconcile uncertain requests.
Live use requires validation of Turnkey's vote/replay behavior and an accepted failover procedure.

**Authorization during requests.** HTTP signing rechecks the active customer and policy revision after
asynchronous checks, before Kora submission, and before returning EVM signed bytes or broadcasting them.
A revoked customer receives `403 CUSTOMER_UNAUTHORIZED`; a changed policy receives `409 POLICY_CHANGED`.
These checks cannot recall an external request already sent. Upstream Kora error text is not returned to
callers or copied into their audit trail because diagnostics may contain private endpoint credentials.

**Finding waiting requests.** Turnkey documents a page size (1 to 100, default 10) and an `after` cursor (an
activity id), but not the order of results, how the list ends, or whether a short page is the last one. AgentGuard asks for 100 at a time and treats only an empty page as the end. A page that brings nothing new also
stops the scan: if it ends at the cursor, it is taken as the end; if not, the cursor is not moving, so the next scan
starts again from the top. Each poll reads at most 20 pages (2,000 requests); the next poll carries on from where the
last one stopped, and wraps to the top after the end. Progress through a long list depends on API pagination behavior and successful polls. If a page request fails, the next poll retries from the same place; if it fails twice there
(the cursor's request may have gone), it starts from the top. Requests already being handled do not depend on the
scan: once their review is decided, or while a vote's outcome is unknown, they are read back by id each poll (up
to 50 per poll). `GET /healthz` reports `turnkey.lastSuccessfulPollAt`, `lastCompleteScanAt`, `lastScan`
(`complete`, `pages`, `resumed`), `consecutivePaginationFailures` and `unresolvedActivities`. Failure details go to
the server log, not to the public health check.

**Restarts.** Each request AgentGuard takes on is recorded in the database, keyed by Turnkey organization and
activity id, with the wallet, customer, agent, transaction hash and policy revision. A repeated poll, a duplicate
webhook or a restart finds the record and does not open another review. Before voting on a recorded request,
AgentGuard reads it again from Turnkey and checks that it still waits, names the same wallet, carries the same
transaction and has the same vote fingerprint. If not, it is rejected and recorded as `MISMATCH`. It also checks
that the wallet is still assigned to the same customer, agent and policy. If the assignment changed, the request is
rejected and recorded as `MISMATCH` with the code `ASSIGNMENT_CHANGED` (in the record's detail and on the
`turnkey_rejected` audit event), and the agent must send it again under the new assignment. An approval or a charge
made for the old assignment is never carried over. If no vote had gone out yet, the charge is refunded. If one
may have, the charge is kept. An approval from a review is spent only under the current policy revision.

The stores cannot share one database transaction, so each external effect carries a durable name instead: the
activity's key, `turnkey:<organization>:<activity id>`. The budget for an activity is charged under that key, and
its review is opened under it. Charging a key that already holds a charge charges nothing more, and refunding it
twice refunds it once; the check and the change are one transaction in the spending ledger. Opening a review for
a key that already has one returns that review, enforced by a unique index. So a step repeated after a crash finds
what the first attempt did:
- **Before the check.** The record is written as `EVALUATING`, with the policy revision at that moment. After a
  crash during the check, a charge already held under the key means the check allowed the transaction: AgentGuard
  votes on that charge if the policy revision is unchanged. If the revision changed, it refunds the charge once and
  checks again. Otherwise it checks again, and finds the review the first check opened instead of opening a
  second one.
- **Before the vote.** The approval is spent, with the activity's key recorded on the review as what spent it, and
  the budget is charged under the key; then `VOTING` is saved. After a crash between the two, the approval looks
  used. Recovery carries on only if the review store shows this activity spent it and the approval still passes
  every check: same customer, agent, transaction, policy and revision, and not stale. A charge held under the key is
  not proof on its own. Otherwise the request is rejected with a code naming why (`APPROVAL_CONSUMED_ELSEWHERE`,
  `APPROVAL_STALE`, `APPROVAL_POLICY_CHANGED` and so on) and the charge is refunded, as no vote went out.
  Approvals spent before the spender was recorded, or through `/gate-and-sign`, name no activity, so they are
  never recovered this way.
- **The vote is its own activity.** AgentGuard's approve or reject vote is a second Turnkey activity, recorded
  apart from the signing request: its kind, its `timestampMs`, the vote activity's id and status, and how many
  distinct requests were sent.
  - **Before sending.** The request, with its `timestampMs`, is saved first. Turnkey answers an identical request
    with the same activity and creates a new activity for a new `timestampMs`. It accepts a `timestampMs` up to one
    hour old, sends no `Retry-After` header, and asks clients to back off exponentially with jitter (Turnkey's
    activities overview and rate-limits pages).
  - **Answer `ACTIVITY_STATUS_COMPLETED`.** Only this counts as a completed vote (`APPROVED` for approve,
    `REJECTED` for reject).
  - **Answer pending, or any status that has not finished, with a vote activity id.** The record is
    `VOTE_PENDING` (or `REJECT_PENDING`). Later passes query that vote activity by id; no new vote is sent.
  - **Answer `FAILED` or `REJECTED` for the vote activity itself.** That vote was not recorded, so a new request
    may be sent.
  - **No answer.** This covers a timeout, a 5xx, a 429, a non-JSON body, or a body without an id. The outcome is
    unknown (`VOTE_UNKNOWN`, code `VOTE_OUTCOME_UNKNOWN`, `VOTE_RATE_LIMITED` or `VOTE_NO_ACTIVITY_ID`). The saved
    request is replayed unchanged, after a backoff of 2 s doubling to 5 minutes with ±20% jitter, for up to 50
    minutes after its `timestampMs`. After that a new request may be sent.
  - **Request limit.** At most 3 distinct requests (`maxVoteSubmissions`) are sent per signing request, for
    approve and for reject separately. A new request always gets a newer `timestampMs` than the last. After that
    the record says `VOTE_ATTEMPTS_EXHAUSTED` (`REJECT_ATTEMPTS_EXHAUSTED` for rejects), no more votes are sent, and
    AgentGuard only watches the signing request.
- **Watching the signing request after AgentGuard's vote.** A completed vote does not finish the signing request:
  it may still need other approvers. After the vote completes (`APPROVED`), is refused (`VOTE_REFUSED`), or its
  requests run out, AgentGuard only reads the signing request.
  - It never votes on it again.
  - Reads back off like retries: 2 s doubling to 5 minutes.
  - When Turnkey reports the request completed, failed or rejected, that is recorded as `SIGNING_COMPLETED` or
    `RESOLVED_EXTERNALLY`.
  - **Observation horizon.** If Turnkey has not finished the request 7 days after AgentGuard stopped voting
    (`watchHorizonMs`), the record becomes `SIGNING_UNRESOLVED`, with code `OBSERVATION_ENDED`. The charge stays,
    and an operator checks the request in Turnkey. AgentGuard does not assume either outcome.
  - **Retention** deletes only finished records, so a record being watched is kept.
  - **Records written before this existed.** `APPROVED` and `VOTE_REFUSED` records count their 7 days from when
    they were created.
- **Requests AgentGuard can only refuse.** On a guarded wallet, these are activity types other than a Solana
  signature, and transactions it cannot read. They are recorded before the reject is sent, as `REJECT_ONLY`:
  - the record holds the organization, activity, wallet, the activity's fingerprint, the wallet's customer, agent
    and policy, and no transaction hash (none is invented);
  - the reject request, its vote activity, backoff and request limit are then kept like any other vote's, across
    polls and restarts;
  - these records never reach a check, a review, a charge or an approve vote.
- **Refunds need proof that nothing was submitted.** Once an approve request may have been sent, AgentGuard never
  gives budget back and never makes the spent approval usable again:
  - a 4xx refusal of the first request (other than 408 and 429) is recorded as `VOTE_REFUSED`, and the signing
    request is read once more to record what happened to it;
  - a signing request Turnkey reports `REJECTED` or `FAILED` keeps its charge too, because Turnkey does not
    document that either status rules out a signature.

  Budget is released only before any approve request was sent: a wallet reassigned, a policy changed, or an
  approval that could not be used, while the record was still `EVALUATING` or `REVIEW_OPEN`.
- **Conservative accounting.** A charge kept this way can overcount the day's spending until the day ends. This avoids refunding a charge solely because a vote or signing outcome is uncertain; it is not a settlement ledger.
- **Settling from the signing request.** A record still deciding is settled from Turnkey's status of the signing
  request: completed gives `SIGNING_COMPLETED`; rejected or failed gives `RESOLVED_EXTERNALLY` (`REJECTED` if
  AgentGuard's reject was pending). The charge is kept in every case. While the request still waits, AgentGuard
  carries on with its recorded vote, never spending the approval or reserving the budget a second time, and only if
  the policy revision and the wallet's assignment are unchanged; otherwise it rejects the request.

This does not make a vote happen exactly once. A new request (a new `timestampMs`) is sent after a vote activity
fails or after the replay window, at most three times. Charges are made once per signing request.
Requests Turnkey finishes without AgentGuard deciding them (cancelled, or approved by a root user) are recorded as
`SIGNING_COMPLETED` or `RESOLVED_EXTERNALLY`. Finished records are deleted by the same retention window as reviews
(`retentionMs`); their charges stay in the day's ledger. The audit log keeps their history (`turnkey_review_linked`, `turnkey_approved`, `turnkey_rejected`,
`turnkey_failed`, `turnkey_resolved`). Without a database path the records are kept in memory and do not survive a
restart.

## Everyday payment instructions

Besides System transfers, SPL `transferChecked` and ComputeBudget, the gate understands two instructions that
ordinary payments often carry and that hold no authority of their own:

- **Associated token account creation** (`Create`, `CreateIdempotent`). The gate re-derives the account from the
  owner, token program and mint and requires an exact match, so an instruction cannot claim an address that is not
  that owner's. The created account is the policy destination: list the vendor's token account in
  `destinationAllowlist` and both the creation and the `transferChecked` pass; creating one for anyone else goes
  to review. `RecoverNested`, extra data and any other account layout go to review.
- **Memo** (v1 and v2): UTF-8 text up to 566 bytes. Anything else goes to review. The text shown to reviewers is
  cut to 120 characters with control and direction characters removed, because it is also read by the optional
  language-model note.

Add `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` and the Memo program
(`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) to `programAllowlist` to use them; without that they are reviewed.
Still reviewed on purpose: SPL plain `transfer` (it names no mint, so its asset is unknown), `approve` and
`setAuthority`. `closeAccount` is decoded and its lamports recipient is checked against `destinationAllowlist`.

Instructions that name a destination but move no amount, such as token account creation, are also checked against `destinationAllowlist`.

## Swaps (Jupiter)

AgentGuard reads Jupiter v6 exact-in swaps: `route`, `shared_accounts_route`, `route_v2` and
`shared_accounts_route_v2`. The decoder uses Jupiter's IDL as fetched from chain (pinned by SHA-256
in `src/agent-integration/idl/`, with where and when it was fetched). It reads every argument, including the full
route plan across all 204 DEX variants, and refuses data with bytes left after the arguments, because the
program would ignore them and a reader that guessed could disagree with what runs.

A swap is ALLOWed only when all of these hold:

- The policy lists the pair in `swapPairs` (`"native"` means SOL; wrapped SOL counts as SOL).
- The input comes from the signer's own token account for that mint. Legacy `route` names no source mint, so
  AgentGuard finds which allowed input mint the source account belongs to.
- The output lands in the signer's own token account for the output mint, or in an account in `destinationAllowlist`.
- The slippage tolerance is at most `maxSlippageBps`, the quote is not zero, and, if the pair sets
  `minOutPerIn`, the guaranteed minimum output (quote minus slippage) is at least that price.
- There is no platform fee, or it is at most `maxPlatformFeeBps` and goes to an allowlisted account. v2 routes do
  not name a fee account, so a v2 platform fee always goes to review. A v2 positive-slippage fee must be at
  most `maxPositiveSlippageBps` (default 0).
- The input amount fits the per-transaction and daily limits for the input mint (`native` for SOL).

The plumbing Jupiter adds around a swap passes without an allowlist entry and is not counted twice, but only
when the same key both sends and owns: creating the signer's own token accounts at its own expense, wrapping SOL
into its own wrapped-SOL account, and closing its own account back to itself.

```json
{
  "policyId": "trading-bot",
  "programAllowlist": ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", "11111111111111111111111111111111",
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    "ComputeBudget111111111111111111111111111111"],
  "destinationAllowlist": [],
  "allowAnyDestination": false,
  "swapPairs": [{ "inputMint": "native", "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "minOutPerIn": "0.00014" }],
  "maxSlippageBps": 100,
  "maxAmountPerTransaction": { "native": "1000000000" },
  "maxAmountPerDay": { "native": "5000000000" },
  "maxPriorityFeePerTransaction": "100000"
}
```

**Simulation.** The checks above read what a swap's instructions say. A route also names the accounts its DEX
steps touch, and only running it shows what happens to them. So when the server has a Solana RPC (on by default;
`SWAP_SIMULATION=false` turns it off), a swap that policy would ALLOW is first simulated, and every account the
transaction names is read before and after. Across the signer's own accounts, only the swap's input asset may go
down, by at most its input amount (plus the network fee when the signer pays it); the output must arrive at or
above the guaranteed minimum; and no token account may change owner or gain a delegate. Anything else, a failed
simulation, or an RPC that does not answer within 8 seconds sends the swap to review, and the response reports the
net change per asset. One limit: the "before"
state is read a moment ahead of the simulation, so funds arriving in the signer's accounts in between could mask an
equal loss of the same asset. Simulation is a point-in-time check, not a guarantee of execution results.

What is not checked: there is no live price feed, so without `minOutPerIn` a swap is bounded only by the
agent's own quote and slippage, which a compromised agent controls. Set a floor for every pair you allow.
Exact-out and token-ledger routes go to review. Swaps should be decided automatically: a human review takes
longer than a quote or a recent blockhash stays valid.

## EVM (Ethereum) gate

An experimental second path for EVM chains, using the same policy object, review queue, evaluation log and
daily-spend tracker as Solana. It is built and tested, and every part of it is **off unless you turn it on**
with the environment variables below (or with `createServer(..., { evmSigner, evmCodeLookup, evmBroadcaster })`
when embedding). Signing depends on the configured `EvmSigner` implementation.

| Variable | Effect |
|---|---|
| `EVM_RPC_URLS` | JSON object of chain id to http(s) RPC URL, e.g. `{"1":"https://..."}`. Turns on the destination code check. Invalid JSON or URLs stop startup. |
| `EVM_BROADCAST=true` | Lets `/gate-and-sign-evm` send transactions itself (`broadcast: true`). Needs `EVM_RPC_URLS`. |
| `EVM_LOCAL_KEY_HEX` + `EVM_ALLOW_LOCAL_KEY=true` | A signing key held in this process, for tests and supervised pilots. Refused without the allow flag, and refused outright when `AGENTGUARD_PRODUCTION=true`. Startup prints the address, never the key. |

With no signer configured, `/gate-and-sign-evm` answers 503. Production EVM signing requires a separately implemented and validated custody signer behind the
`EvmSigner` interface; the bundled local-key signer is refused in production mode.

```
POST /evaluate-evm        {agentId, policyId, transaction:{chainId, from, to, value, data}}      decide only
POST /evaluate-evm-typed  {agentId, policyId, from, typedData}                                   permits (EIP-712)
POST /gate-and-sign-evm   {agentId, policyId, transaction:{..., nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas}, reviewId?, broadcast?}
```

**What it reads.** Native transfers; ERC-20 `transfer`, `approve`, `increaseAllowance`, `transferFrom`;
`setApprovalForAll`; WETH `deposit`/`withdraw`; EIP-2612, DAI-style and Permit2 permits; and Uniswap SwapRouter02
swaps and multicalls on Ethereum mainnet. Anything else, anything malformed, and anything it cannot verify is
reviewed, never guessed. The contract maps to `programId`, the recipient or spender to `destination`, the token
(or `native`) to the asset, so the Solana limits and allowlists apply unchanged.

**Policy fields that matter for EVM.**

| Field | Meaning |
|---|---|
| `allowedChainIds` | Required. Absent or empty means no EVM chain is allowed. |
| `destinationAllowlist` | Recipients and spenders. A swap to yourself maps to the router, so list the router. Empty means review unless `allowAnyDestination: true`. |
| `maxAmountPerTransaction` / `maxAmountPerDay` | Per asset (token address or `native`). `evm:gas` caps the worst-case network fee (`gasLimit x maxFeePerGas`); with no `evm:gas` cap the answer is review. |
| `maxPermitLifetimeSeconds` | Longest validity for a permit or a Uniswap `multicall` deadline. Default 86400. Longer goes to review. |
| `trustedDelegates` | Implementation addresses an account may be delegated to (EIP-7702) without review. |

**Checks that use the network (opt in).** With `evmCodeLookup` (for example `rpcCodeLookup({ 1: "<rpc url>" })`)
the gate reads the code behind each destination: an account delegated by EIP-7702 goes to review unless its
delegate is in `trustedDelegates`, an unapproved contract goes to review, and code it cannot read
goes to review. Without a lookup this check is off.

**Signing.** `evmSigner` is an interface. `LocalKeySigner` holds a key in memory and is for tests and supervised
pilots only; it is not a production custody integration.
`/gate-and-sign-evm` returns the signed bytes. With `broadcast: true` (needs `evmBroadcaster`, for example
`rpcBroadcaster`) the server keeps the bytes, re-reads the destination code uncached just before sending, and
returns the transaction hash. If the destination changed it answers 409 and sends nothing; if the node fails it
answers 502 and keeps the budget and approval spent because the outcome is unknown.

**What it does not do.**

- It does not check prices or slippage beyond refusing a zero minimum output, and it does not support swaps paid in ETH.
- Uniswap is recognised on Ethereum mainnet only; other chains' routers have not been verified.
- The code check sees the chain at one moment. Broadcast mode narrows the gap to seconds; on-chain
  enforcement would be needed to bind checks to execution.
- Fork tests require a separately configured Anvil fork and are skipped without `EVM_FORK_RPC`.
  Local fake-service tests do not establish current behavior against a live provider.

## Known limitations

Deployment and implementation limits:

- **Review details require reviewer authentication. Reviewer login is a
  personal bearer token, not SSO or MFA.** A review link opens a sign-in shell with
  no transaction details. Reading a review, approving it, or denying it needs either a named
  reviewer's token (`node scripts/reviewers.mjs add "Name"`, shown once, stored
  only as a SHA-256 hash) or, unless `REVIEW_REQUIRE_REVIEWERS=true`, the legacy
  shared `REVIEW_ACTION_SECRET`. A resolution made with a reviewer token records
  who did it (kept even after that reviewer is revoked); one made with the shared
  secret is recorded as "shared secret, no individual identified". With neither
  configured, review details and actions fail closed. Customer-scoped reviewers
  can read and act only on their customer's reviews.
  A token is only as safe as its holder: anyone who obtains it is that
  reviewer, there is no second factor or automatic token expiry; replacement requires revoking the old reviewer and provisioning a new token, and the
  record of who resolved a review is one row per review, not a full audit log
  of failed attempts. Pending reviews expire after 15 minutes by default
  (`REVIEW_EXPIRY_MS`), and approve/deny attempts are limited per IP to the
  server rate limit (30 requests per 60 seconds by default). Deployments still
  need gateway rate limiting. A stronger gate needs SSO or MFA and a full audit log.
- **Pending reviews, evaluation history, daily spend totals, and rate-limit
  windows are durable.** The production entrypoint stores these in a local
  SQLite file (`AGENTGUARD_DB_PATH`, default `agentguard.sqlite`) so a restart
  does not erase an approval request, its audit trail, a day's approved-spend
  total, or the current review-secret guessing budget. `DailySpendTracker` is best-effort accounting for
  transactions approved by this service, not a reconciled on-chain settlement
  ledger: it has no transaction identity or settlement-status reconciliation.
  SQLite is local-disk persistence, not a distributed datastore:
  it has no replication, backup policy, encryption, or cross-host coordination.
  It depends on Node's built-in `node:sqlite` module. The configured Node runtime
  may emit an experimental API warning. See `test/persistence.test.ts` for the
  local persistence and concurrent-write regression coverage.

- **The dependency audit snapshot below reports 12 affected packages** (6 moderate,
  6 high; these include transitive dependency propagation), through the Solana SDK dependency graph: `@solana/web3.js`,
  `@sqds/multisig`, and their transitive RPC and token packages. The
  available automated fixes require major dependency changes, so this
  prototype does not apply them blindly.
- **The Squads upgrade gate reports a pending buffer's bytecode fingerprint,
  but does not verify that fingerprint against source code.** It tells a
  signer whether the target program has verified-build history and reports
  the SHA-256 of the proposed buffer's executable bytes for comparison with
  a separately trusted deterministic build. OtterSec's public API documents
  verification status by deployed program ID, not pending buffer ID, so the
  fingerprint is evidence for human review. It is not a verified-build
  result or a pass/fail decision.

### Dependency advisories (checked 10 November 2026)

The 10 November audit snapshot reported 12 affected packages (6 high, 6 moderate), including transitive dependency propagation. This is a dated snapshot, not a current vulnerability assessment. We did not force the
upgrades `npm audit fix --force` offers, because they are major version changes (for example downgrading
`@sqds/multisig`). The following import-path observations are not a full exploitability or reachability analysis:

- **bigint-buffer (buffer overflow in `toBigIntLE`) and the packages that bring it in** (`@solana/spl-token`,
  `@solana/buffer-layout-utils`, `@metaplex-foundation/beet-solana`, and `@solana/spl-token-metadata`): reached only
  through `@sqds/multisig`, which only `src/gateway/squads-upgrade-gate.ts` imports. That is the
  `/squads/upgrade-check` feature, which reads on-chain accounts from the RPC you configured. It is not on the path
  of a transaction an agent submits to `/evaluate` or `/gate-and-sign`.
- **jayson, uuid, stream-json** (denial of service on crafted JSON, a missing bounds check): brought in by
  `@solana/web3.js`'s RPC client, which parses replies from the RPC endpoint you configured. Use an RPC you trust.
- **zod in `solana-clear-sign`**: our own API validation runs zod 4.6.7, which has the fix. `solana-clear-sign`,
  our pinned decoder dependency, carries its own zod 3 copy, which validates the interface descriptions the
  operator registers, not request bodies. Moving it to zod 4 is a change in that repository.

Re-run `npm audit` before each release. Evaluate upgrades with the full test suite rather than forcing major dependency changes.


## Runtime configuration

Use Node 22.19 or newer for the documented backup workflow. The package minimum is
22.13; the container pins 22.19.0. Install with `npm ci` to preserve the lockfile.

| Setting | Purpose |
|---|---|
| `PORT` | HTTP port, default 8787 |
| `RPC_URL` | Solana RPC for account reads and lookup tables; default devnet |
| `KORA_RPC_URL` | Required to enable the Solana relayer signing route |
| `AGENTGUARD_DB_PATH` | SQLite state file; use persistent storage |
| `AGENTGUARD_RETENTION_DAYS` | Review and evaluation-history retention, default 30; `off` disables pruning |
| `BASE_URL` | Public URL used in review links |
| `SLACK_WEBHOOK_URL` | Optional default notification webhook |
| `SOLANA_CLUSTER` | Set `mainnet-beta` to enable mainnet verification-history checks |
| `REQUIRE_RPC_NETWORK_MATCH` | Enforce configured network identity outside mainnet too |

Mainnet startup checks the RPC genesis hash. A strict network mismatch prevents startup.
Audit events are not pruned by review/history retention. Deleted review records lose
their per-review attribution; retain required audit evidence separately.

## Container

The Dockerfile builds from the lockfile, runs as the unprivileged `node` user and
stores state at `/data/agentguard.sqlite`. Mount `/data` on persistent storage.
`NODE_ENV=production` alone does **not** enable AgentGuard's production safeguards.
Set every required variable described under [Running it in production](#running-it-in-production),
provision customer policies and named reviewers against the same database, and
configure HTTPS and the exact trusted proxy count before exposing the service.

`GET /healthz` is a process-health endpoint. It does not establish signing readiness,
correct wallet permissions, or successful on-chain execution.

## EVM fork tests

The `test/evm*-fork.test.ts` suites require `EVM_FORK_RPC` pointing to an isolated
Anvil fork. They are skipped without it. Use a separate test environment, never a
production RPC that accepts real broadcasts. Shared-account fork tests may require
`--test-concurrency=1`. A passing local fake-based suite does not establish live
custody-provider behavior.
