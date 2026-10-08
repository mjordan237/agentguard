# AgentGuard

<img src="assets/agentguard-logo.svg" width="96" alt="AgentGuard shield logo">

A security layer for autonomous AI agents that transact onchain.
AgentGuard sits between an agent and its wallet: it decodes registered
instructions, checks the decoded intent against policy, and auto-approves
within policy or holds the transaction and routes it to a human before
funds move. Unknown or unverified instructions fail closed to human
review rather than being guessed at or silently allowed. It doesn't
compete with wallet providers like Coinbase, Turnkey, or Crossmint --
it's the security layer that sits on top of them.

Starting on Solana. The policy-and-decode engine underneath this repo is
called ClearSign, built on
[`solana-clear-sign`](https://github.com/mjordan237/solana-clear-sign)'s
authenticated-IDL, bounds-checked instruction decoder.

Built for Colosseum's Crypto World's Fair hackathon (Solana Ecosystem
track, deadline Oct 12, 2026).

The project logo is available at
[`assets/agentguard-logo.svg`](assets/agentguard-logo.svg). The internal
submission handoff checklist is at
[`demo/colosseum-submission-worksheet.md`](demo/colosseum-submission-worksheet.md).

## The idea

An AI agent constructs a Solana transaction -- e.g. paying a vendor for
completed maintenance work, or settling an [x402](https://solana.com/x402)
agentic payment. Before it signs, AgentGuard's ClearSign engine decodes
the transaction's registered instructions (reusing `solana-clear-sign`'s
authenticated-IDL, bounds-checked decoder -- an instruction with no
matching registry entry falls to `raw_dump` rather than being decoded),
checks it against a policy
(program allowlist, destination allowlist, spend limits), and either
auto-approves it within policy or blocks it and routes it to a human with
a clear, human-readable diff of what it actually does -- not what it
claims to do. `POST /gate-and-sign` shows this pattern working end to
end against a real wallet-adjacent relayer, Kora -- the same shape this
takes in front of any agent wallet.

## Why this fits the hackathon

Colosseum's own schedule for this cycle includes a "Solana Agentic
Payments" workshop (Sep 23, 2026). Solana is a founding Premier Member of
the [x402 Foundation](https://solana.com/x402) (under the Linux
Foundation, alongside Coinbase, Cloudflare, Circle, Stripe, Visa,
Mastercard, Google, and AWS), and Solana carries roughly 70% of monthly
x402 transaction volume. A July 2026 USENIX-accepted security paper,
["When HTTP 402 Meets the Blockchain"](https://arxiv.org/abs/2607.19545),
found policy violations in every one of 15 production x402 facilitators
it tested -- this project is a direct response to that gap.

### Prior art and honest differentiation

Real, existing Solana agent-transaction firewalls: [Prflght](https://www.prflght.xyz/)
(program allowlists + on-chain attestation) and [TruCore ATF](https://trucore.xyz/)
(spend caps + a fixed DeFi-venue allowlist) both enforce by blocking
outright on a policy violation. [Privy's policy
engine](https://docs.privy.io/controls/policies/overview) does pre-sign
policy checks in a secure enclave and, per its current docs, also
supports decoding arbitrary custom program instructions via Anchor IDLs
-- parameter-level decoding on Solana is not unique to this project, and
this README shouldn't have implied otherwise.

What AgentGuard adds on top of that: an anomaly never dead-ends in a
silent block. `NOT_AN_UPGRADE`, `NEEDS_REVIEW`, and every other
non-`ALLOW` outcome routes to a structured human-review record --
Slack escalation, a real approve/deny page, an audit log queryable per
agent -- rather than just rejecting the transaction and moving on. It
also spans two surfaces in one tool: gating an agent wallet's own
payment signing (via Kora) and reading live Squads multisig proposals to
flag pending program upgrades for review. `solana-clear-sign`'s
authenticated-IDL, bounds-checked decoder (cryptographically binding the
IDL used to the observed on-chain program ID, so a spoofed or mismatched
IDL can't decode) is what this project's policy and escalation layer is
built on.

## Status

**Decode integration is real and working end to end**, verified with an
actual transaction over HTTP, not a mock:

```
POST /evaluate {agentId, policyId, transactionBase64}
  -> parses the transaction (@solana/web3.js)
  -> looks up each instruction's program in the IDL registry
  -> resolves the instruction name from its discriminator
  -> decodeVerifiedInstruction() (solana-clear-sign) -- IDL-digest and
     program-identity verified before decoding
  -> evaluatePolicy() -> ALLOW / NEEDS_REVIEW
```

Deliberately two outcomes, not three: an anomaly always routes to a human
via `NEEDS_REVIEW` rather than being silently, autonomously blocked.
Nothing in this pipeline denies a transaction on its own.

Confirmed working: a real `SystemProgram.transfer` instruction, built
with `@solana/web3.js`, submitted over a live HTTP server, decodes to
`{lamports, from, to}` and returns `ALLOW`. A program not in the registry
correctly falls back to `raw_dump` / `NEEDS_REVIEW` instead of silently
passing.

**Address Lookup Table resolution is real and confirmed working.**
`src/index.ts` wires a real `Connection` (defaults to devnet, override
with `RPC_URL`) and resolves ALTs via `Connection.getAddressLookupTable`
before decoding. Verified with a real v0 transaction whose destination
account exists *only* inside an Address Lookup Table -- never in static
account keys at all -- and confirming it resolves to the correct
address (`test/address-lookup-tables.test.ts`). Still fails closed, on
purpose, in two cases: no resolver configured, or the resolver can't
find the table -- per the x402 SVM spec's Sponsor Acceptance Policy, an
unresolved ALT must be rejected, not assumed safe.

**Demo scenario is also real and confirmed working** (`demo/`) -- two
runs, no mocked decode/policy calls. A legitimate vendor payment decodes
cleanly and returns `ALLOW`. The same payment with a second, injected
`SystemProgram.assign` instruction (an authority-hijack attempt that
moves zero balance -- invisible to a balance-diff-only simulator) is
shown right alongside the legitimate-looking transfer and correctly
returns `NEEDS_REVIEW`, in original transaction order. See `demo/README.md`
for actual captured output and how to run both.

**Human escalation is also real and confirmed working end to end**
(`src/escalation/`). A `NEEDS_REVIEW` decision creates a pending review,
posts a decoded-diff message to a Slack Incoming Webhook (best-effort --
a failed Slack post never hides the decision or crashes the request),
and returns a link to a self-hosted `/review/:id` page with Approve/Deny
buttons. Approving or denying resolves the review and re-renders the
page without the buttons. Tested with a fake local Slack-webhook
receiver plus a full evaluate → escalate → approve HTTP cycle
(`test/escalation.test.ts`) -- no mocked network calls.

Deliberately **not** using Slack's interactive Block Kit buttons: those
need a full Slack App with an interactivity request URL and
signing-secret verification, which is real scope on its own. A plain
link to our own approve/deny page gets the same human-in-the-loop
outcome without it. To actually post to Slack, set `SLACK_WEBHOOK_URL`;
without it, the review page still works, there's just no Slack
notification.

**`POST /evaluate`, `POST /gate-and-sign`, and `POST /squads/upgrade-check`
are all rate-limited, real and tested** (`src/api/rate-limiter.ts`). A
fixed-window limiter, 30 requests per 60 seconds per source IP by
default, configurable via `ServerConfig.rateLimit`, returns `429
RATE_LIMITED` once exceeded. This closes the gap where hammering
`/evaluate` could trigger a real Slack post for every `NEEDS_REVIEW`
result, and the same protection covers the Squads endpoint's real RPC
and OtterSec calls -- the limiter sits in front of each route, so a
flood never reaches policy evaluation, Slack, or any external call at
all. Like the other in-memory stores in this project, the limiter's
state resets on restart and doesn't share across multiple server
instances; a real deployment running more than one instance needs a
shared backing store.

**Destination-allowlist and spend-limit enforcement is also real and
confirmed working.** `evaluatePolicy` now checks `destinationAllowlist`,
`maxAmountPerTransaction`, and `maxAmountPerDay` -- but only for
instructions the registry explicitly declares as policy-relevant
(`InstructionPolicyMetadata`, in `idl-registry.ts`). Destination and
amount are resolved from the *verified decode result*, not guessed from
IDL field names by convention -- deciding "the account named 'to' is
the destination" is exactly the kind of unverified assumption this
project exists to avoid, so that mapping is declared explicitly per
program by whoever curates the registry, not inferred.

Two demo scripts prove this catches things the raw_dump/program-allowlist
checks do **not**: `demo/unapproved-destination-payment.ts` is a fully,
cleanly decoded transfer -- no hidden instruction, nothing a
discriminator check would flag -- to a destination that isn't an
approved vendor, and it's still correctly blocked. `demo/over-limit-payment.ts`
is the same, for an amount over the per-transaction cap. Daily-limit
tracking is real too, via `DailySpendTracker` (in-memory, resets on
process restart) -- only transactions that were actually `ALLOW`ed count
against the day's budget, wired in at the server layer so the policy
evaluator itself stays a pure, testable function.

**Observability log is also real and confirmed working** (`src/observability/`).
Every `/evaluate` call is now recorded -- `ALLOW` decisions included, not
just the `NEEDS_REVIEW` ones `PendingReviewStore` already tracked --
against the agent that submitted it, the policy it was checked against,
and the full decoded evaluation. `GET /agents/:agentId/history` returns
that agent's evaluation history (most recent first, optionally filtered
by `?decision=`) plus a running `{total, allow, needsReview}`
summary; `GET /transactions/:id` returns one entry by its `logEntryId`
(now returned from every `/evaluate` response, ALLOW included). This is
the piece that makes ClearSign an actual record of what agents tried to
do over time, not just a stateless pass/fail gate. In-memory today
(`EvaluationLog`), same as the other stores here -- the query interface
is written so a real database can replace the storage later without
changing callers.

**`POST /gate-and-sign` gates Kora, the Solana Foundation's own relayer,
and is real and tested** (`src/gateway/kora-gate.ts`). Kora already does
program allowlisting and per-instruction-category fee-payer permissions
natively, but not authenticated-IDL argument-level decoding -- that's the
gap this fills. The flow: an agent's transaction goes through the same
decode-and-policy check as `/evaluate`; only on `ALLOW` is it forwarded
to Kora. A `NEEDS_REVIEW` decision is blocked before Kora is ever called
-- tested by counting real RPC calls against a local server speaking
Kora's actual wire format, not by asserting on a mock. A Kora-side
failure returns `KORA_SIGNING_FAILED`, never a false `ALLOW`; no
`KORA_RPC_URL` configured returns `KORA_NOT_CONFIGURED` rather than
silently skipping the sign step.

Before forwarding anything, `signThroughKora` calls Kora's real
`getPayerSigner` method and checks the incoming transaction's fee payer
against it. Kora's signing model keeps the fee payer and the
value-transfer authority as two separate roles (confirmed against real,
live Kora instances on both devnet and mainnet, see below); a
transaction built any other way either fails at Kora or, worse, would
need Kora's own signer to also be a transfer source, which Kora's own
config validator specifically warns against allowing (it can let a
malformed request drain the fee payer). A mismatch fails closed with
`400 KORA_FEE_PAYER_MISMATCH`, naming both the fee payer that was
actually found and the one Kora expects, before Kora is ever called.
Only once that checks out does it call `signAndSendTransaction`, not
sign-only: by the time a transaction reaches this point it already
carries the agent's own signature authorizing their transfer, Kora's is
the last signature needed, so there's no reason to withhold submission
once it's added. The response now carries a real transaction signature,
not just signed bytes.

The fake server in `test/kora-gate.test.ts` speaks Kora's real JSON-RPC
method names and request/response shapes (verified against
`@solana/kora`'s own type declarations), including `getPayerSigner` and
`signAndSendTransaction`, and a dedicated test proves the fee-payer
check actually fails closed rather than just existing in theory. Beyond
the fake server, the same decode-and-policy code has also been run
against a real, locally installed `kora rpc` process with a live signer,
on both devnet and real mainnet (`scripts/kora-live-test/`). On
2026-10-07, a transaction was decoded, policy-evaluated, and (on
`ALLOW`) handed to that live Kora instance, which signed it as fee payer
and submitted it; the mainnet run moved a small real amount and
finalized on-chain, transaction
`3FrjQdVhERCcA83JLMLNLCFaK8zws62S8PLR56BaS8vA9ztBxPcZH9HPXa6CSepYP6B7Ytx8JVkrLG3N2XUDhiwe`,
independently re-verifiable by anyone against the real balances and the
transaction's own `preBalances`/`postBalances`. The existing demo
scripts still build transactions the old, decode-only-testing way
(agent as its own fee payer) since they never submit anywhere; that's
fine for what they're for, and deliberately left alone rather than
changed to match materials already recorded against them.

**`POST /squads/upgrade-check` is a second, narrower gate: a Squads V4
multisig program-upgrade proposal, checked against its real on-chain
proposal status and verification history, real and tested**
(`src/gateway/squads-upgrade-gate.ts`). The gap this targets is
different from Kora's: Squads' own documentation tells signers to
manually run `solana-verify` themselves and compare hashes by hand
before approving an upgrade -- nothing in Squads' UI surfaces
build-verification status at the point of signing. Given a multisig
and a pending transaction index, this derives both the `VaultTransaction`
and `Proposal` PDAs (via `@sqds/multisig`), reads both accounts, and
validates each account's owner against the trusted Squads program
before deserializing -- the trusted program ID is server-side
configuration, defaulting to the real Squads V4 program, and is never
accepted from the request body, so a caller can't redirect which
program's accounts are trusted. It checks the real `Proposal` status:
only `Active` and `Approved` represent a pending signer decision, so a
`Rejected`, `Cancelled`, `Executed`, `Executing`, or `Draft` proposal is
reported as `NOT_PENDING` with its real status named, never described
as pending.

For a pending proposal, the compiled instructions are scanned for a
genuine BPF Upgradeable Loader `Upgrade` instruction (discriminator and
account order verified against the real `solana-loader-v3-interface`
enum, not guessed -- encoded with bincode, not Borsh, though that
doesn't change the byte value checked here). Account indexes are
resolved against the *complete* key list, including any Address
Lookup Table entries referenced by the proposal's message: static
keys, then every writable ALT entry (table order, then index order),
then every readonly entry, fetched live via the configured RPC
connection. A missing lookup table, an out-of-range index, or an RPC
failure during resolution fails closed to `ANALYSIS_INCOMPLETE` --
incomplete analysis is never reported as `NOT_AN_UPGRADE`, which is the
false-negative this closes: an upgrade routed through an ALT used to
resolve against the static keys alone and come back looking like no
upgrade at all.

If found, the target program's verification history is checked against
OtterSec's real, live `verify.osec.io` API -- but only when the
endpoint is configured with `SOLANA_CLUSTER=mainnet-beta`, since
verify.osec.io's remote verification only covers mainnet (confirmed on
`solana.com/docs/programs/verified-builds`) and the program ID alone
doesn't prove which cluster a proposal lives on. Any other configured
cluster, or none, returns `UNKNOWN` without even making the request,
rather than attributing mainnet evidence to a devnet or custom-RPC
proposal. The result is one of three explicit outcomes --
`VERIFIED`, `UNVERIFIED`, or `UNKNOWN` -- never a lossy boolean: an
HTTP 429/5xx, a network error, a timeout (bounded at 5s via
`AbortController`), invalid JSON, or a schema-invalid response all
become `UNKNOWN` with an honest reason, never a false "no verified-build
record." The configured cluster is included in the response so a
caller can see what the on-chain read and the verification check were
each attributed to.

Honest scope limit, stated plainly rather than implied away: even a
`VERIFIED` outcome reports whether the program has *any* verified-build
record on file, not a live cryptographic proof that the *specific
pending buffer* matches it byte-for-byte. Doing that would mean
computing the buffer account's own executable hash directly, and the
exact on-chain byte layout for that wasn't confirmed precisely enough
here to do safely -- guessing at it risked a silent, wrong hash that
looks correct. Every upgrade this detects returns `NEEDS_REVIEW`,
never an autonomous `ALLOW`, regardless of verification outcome; it
hands a human real context where today they'd see nothing at all, not
a cryptographic guarantee it doesn't yet have.
`test/squads-upgrade-gate.test.ts` unit-tests discriminator/account-order
parsing, ALT resolution (including multi-table ordering and every
fail-closed path), and the tri-state verification outcome (including
every provider-failure path) against an injectable fetch boundary, so
the default suite is deterministic and doesn't depend on
`verify.osec.io`'s live availability. `test/squads-upgrade-endpoint.test.ts`
builds real `VaultTransaction` and `Proposal` accounts, serializes them
through `@sqds/multisig`'s own beet serializer (not a hand-typed byte
buffer), and feeds those real bytes through the actual
fetch-both-accounts-and-deserialize path the endpoint uses -- including
an upgrade routed entirely through a lookup table, every terminal
proposal status, and every account-authenticity fail-closed case
(missing account, wrong owner, embedded multisig/index mismatch, and a
requester-supplied `squadsProgramId` that the request schema simply
doesn't accept).

Beyond the test suite, the gate has also been run against a real,
live mainnet multisig, not just synthetic fixtures. On 2026-10-07, the
compiled `evaluateSquadsUpgradeProposal` was pointed at multisig
`92hjPSVuKEmf64BgEquEg4NJPR2wAvKCdU5pW97BB7EM` and transaction index
`3`, a genuine Squads multisig found via a live `getSignaturesForAddress`
query against the Squads program on `api.mainnet-beta.solana.com`, not
an address picked in advance. It correctly read the real on-chain
`VaultTransaction` and `Proposal` accounts (the transaction's message
even referenced a real Address Lookup Table, exercising that resolution
path against live mainnet data) and returned `NOT_PENDING` with
`proposalStatus: "Executed"`, matching the proposal's actual state.
Anyone can re-verify this independently against the same address.

Every piece described in this document is real, built, and tested --
there's no remaining "not yet built" list for the code itself. The
decode-and-policy code has now been run against a real live Kora node on
both devnet and mainnet (see above), `/gate-and-sign` validates the
fee-payer identity and signs-and-sends rather than sign-only, both
previously open questions, now resolved and tested. Computing a pending
buffer's own executable hash for the Squads gate remains the one
real-world step not yet done, called out above rather than glossed
over.
`npm test` runs 70 tests across decode integration, policy enforcement, escalation, ALT
resolution, the observability log, rate limiting, the Kora gate, and the Squads
upgrade gate, all exercising real code paths (real transactions, a real
local HTTP server, a real fake-Slack-webhook receiver, a real
fake-Kora-RPC server speaking Kora's actual wire format, a real
locally-constructed `AddressLookupTableAccount`, real `VaultTransaction`
and `Proposal` accounts serialized through `@sqds/multisig`'s own
serializer) rather than mocks. Live calls to `verify.osec.io` are
exercised through the injectable fetch boundary rather than the
network, so the suite has no external dependency.

## Known limitations

Honest, not hidden -- these are hackathon-scale tradeoffs, not bugs
discovered after the fact:

- **Review pages are readable by anyone with the link, and review actions
  use one shared secret rather than a real identity system.**
  `REVIEW_ACTION_SECRET` is required to approve or deny; when it is unset,
  actions fail closed and stay disabled, while the decoded review remains visible.
  Pending reviews expire after 15 minutes by default (configure
  `REVIEW_EXPIRY_MS` in milliseconds), and an approval or denial records a
  `resolvedAt` timestamp. This is deliberately not per-user authentication:
  a shared secret proves only that the actor knew the secret, not who they
  were, review approve/deny attempts are limited per IP and endpoint family
  to the configured server rate limit (30 requests per 60 seconds by default),
  and the record is not attributable to an individual identity. Deployments need a
  high-entropy secret plus gateway rate limiting. A production approval gate
  needs authenticated, attributable actors plus durable audit storage.
- **Pending reviews, evaluation history, and daily spend totals are durable;
  rate limits remain intentionally in-memory.** The production entrypoint
  stores `PendingReviewStore`, `EvaluationLog`, and `DailySpendTracker` in a
  local SQLite file (`AGENTGUARD_DB_PATH`, default `agentguard.sqlite`) so a
  restart does not erase an approval request, its audit trail, or a day's
  approved-spend total. `DailySpendTracker` is best-effort accounting for
  transactions approved by this service, not a reconciled on-chain settlement
  ledger: it has no transaction identity or settlement-status reconciliation.
  `RateLimiter` remains process-local and resets on restart. SQLite is
  local-disk persistence, not a distributed datastore:
  it has no replication, backup policy, encryption, or cross-host coordination.
  It also depends on Node's built-in `node:sqlite` module, which Node itself
  still flags as experimental (confirmed: every run prints
  `ExperimentalWarning: SQLite is an experimental feature and might change
  at any time`) -- real and working today, verified with an actual process
  restart and two separate OS processes writing concurrently
  (`test/persistence.test.ts`), but worth knowing the underlying API isn't
  Node's own stable surface yet.
- **`npm audit` currently reports 10 inherited advisories** (6 moderate,
  4 high), through the Solana SDK dependency graph: `@solana/web3.js`,
  `@sqds/multisig`, and their transitive RPC and token packages. The
  available automated fixes require major dependency changes, so this
  prototype does not apply them blindly.
- **The Squads upgrade gate reports a pending buffer's bytecode fingerprint,
  but does not verify that fingerprint against source code.** It tells a
  signer whether the target program has verified-build history and reports
  the SHA-256 of the proposed buffer's executable bytes for comparison with
  a separately trusted deterministic build. OtterSec's public API documents
  verification status by deployed program ID, not pending buffer ID, so the
  fingerprint is explicitly evidence for human review—not a verified-build
  result or a pass/fail decision.

## Structure

- `src/policy/` -- policy schema and the allow/needs-review evaluator
- `src/agent-integration/` -- transaction parsing, IDL registry,
  discriminator resolution, the `solana-clear-sign` decode wiring
- `src/api/` -- the agent-facing `POST /evaluate`, `POST /gate-and-sign`,
  and `POST /squads/upgrade-check` HTTP API
- `src/escalation/` -- human-in-the-loop approval: pending-review store,
  Slack webhook notification, self-hosted approve/deny review page
- `src/observability/` -- the evaluation log: every `/evaluate` call,
  queryable per-agent, with a running decision summary
- `src/gateway/` -- the Kora gate (signs an ALLOWed transaction through
  Kora's real JSON-RPC client, never called for NEEDS_REVIEW) and the
  Squads upgrade gate (reads a pending program-upgrade proposal and
  checks its verification history)
- `demo/` -- four end-to-end scenarios for the pitch video: legitimate
  payment, hidden-instruction hijack, unapproved destination, over
  spend limit
- `test/` -- unit and integration tests: policy evaluation, real
  transaction decoding, Slack escalation over real HTTP, Address
  Lookup Table resolution, the observability log, the Kora gate, and
  the Squads upgrade gate

## Dependencies

Depends on [`solana-clear-sign`](https://github.com/mjordan237/solana-clear-sign),
pinned to a commit via a `github:` dependency. That repo carries a
`prepare` script so its `dist/` actually builds on install -- verified
end to end with a real clean install (`rm -rf node_modules dist
package-lock.json && npm install && npm run build && npm test`, 29/29
pass) against the GitHub dependency, not a local path.

Also depends on [`@solana/kora`](https://www.npmjs.com/package/@solana/kora),
the Solana Foundation's own published client, for `/gate-and-sign`, and
on [`@sqds/multisig`](https://www.npmjs.com/package/@sqds/multisig),
Squads' own published SDK, for `/squads/upgrade-check`.

```
npm install
npm run build
npm test
PORT=8787 SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... KORA_RPC_URL=http://localhost:8080 REVIEW_ACTION_SECRET=replace-with-a-long-random-secret AGENTGUARD_DB_PATH=./agentguard.sqlite node dist/src/index.js
```

`SLACK_WEBHOOK_URL` is optional -- omit it to run without Slack
notifications (the `/review/:id` approve/deny page still works either
way). `REVIEW_ACTION_SECRET` is required for approve/deny actions; omit it
to leave review pages view-only. `REVIEW_EXPIRY_MS` defaults to 900000
(15 minutes). `BASE_URL` controls the link posted to Slack and returned in the
API response; defaults to `http://localhost:$PORT`. `RPC_URL` controls
where Address Lookup Tables get resolved from; defaults to
`https://api.devnet.solana.com`. `KORA_RPC_URL` is optional -- omit it
to run `/evaluate` only; set it to a running Kora instance's RPC URL to
enable `/gate-and-sign`, which fails closed with `KORA_NOT_CONFIGURED`
otherwise. `SOLANA_CLUSTER` is separate from `RPC_URL` and only affects
`/squads/upgrade-check`'s verification-history check -- it must be set
to exactly `mainnet-beta` for that check to call `verify.osec.io` at
all (the on-chain proposal read itself still happens against whatever
cluster `RPC_URL` points to); any other value, or leaving it unset,
makes verification checks return `UNKNOWN` rather than silently
assuming mainnet. `AGENTGUARD_DB_PATH` selects the SQLite file for durable
reviews and evaluation history; it defaults to `agentguard.sqlite` in the
current working directory. Node 22.13 or newer is required for Node's built-in
SQLite module.
