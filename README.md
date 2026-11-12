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
[`assets/agentguard-logo.svg`](assets/agentguard-logo.svg).

## Try it in a minute

Needs Node 22.13 or newer. Nothing leaves your machine: the quickstart uses a stand-in relayer that returns a
fake signature, so there are no keys, no network and no money.

```
npm ci
npm run build
npm run quickstart
```

It starts the real server and walks through what you would see first: a normal payment that is allowed and
signed, the same payment with a hidden instruction that is held for a person, a payment to an unapproved
address and one over the limit, and then the review step. Open the printed review link, sign in with the printed
reviewer token, and click Approve; the agent's retry is then signed once, and using the same approval again is
refused. `npm run quickstart -- --auto-approve --exit` does the approval for you and exits, which is handy as a
smoke test. Set `PORT` to change the port (default 8787).

Measured on one laptop with a warm npm cache, from a fresh copy: install 3.6 s, build 1.4 s, the whole
walkthrough 0.8 s. A cold cache or a slow disk will take longer.

### Public sandbox API

`npm run sandbox` starts a separate, public-facing server (port 8788 by default) where anyone can check a
transaction against a policy they send. It cannot sign, holds no keys, does not store requests, does not
rehearse swaps or track spending across requests (daily limits use the `spentToday` the request supplies), opens no reviews and has
none of the gate's routes; it runs the same engine as `npm run check`. `GET /` is a docs page with a playground,
`GET /openapi.json` describes the API, and `GET /v1/examples` returns request bodies to try, each with the
decision it should get.

```
curl -s localhost:8788/v1/check -H 'content-type: application/json' \
  -d '{"chain":"solana","transactionBase64":"<base64>","policy":{...},"spentToday":{"native":"0"}}'
```

**Verifying a result.** Every response carries `receipt.inputHash` (SHA-256 of the input as understood:
the parsed policy, the transaction, what was spent, and the lookup tables used) and `receipt.resultHash`
(SHA-256 of the decision, reasons, decoded instructions and spend), both over JSON with sorted keys. Check out
the commit `GET /v1` reports as `sourceCommit`, run `npm run check -- --json` on the same input (pass
`--lookup-tables` with the `lookupTables` the response returned), and the receipt must be identical. Key order
and whitespace in a request do not change it.

Settings: `PORT`, `SANDBOX_REQUESTS_PER_MINUTE` (default 60 per client), `TRUST_PROXY`, `SOURCE_COMMIT`
(Railway's `RAILWAY_GIT_COMMIT_SHA` is used if set), `SANDBOX_REPOSITORY_URL` (shown on the docs page; defaults to the public GitHub repository) and, optionally, `SANDBOX_RPC_URL` to read lookup tables a
request does not include. Bodies are capped at 64 KB and at most 8 lookup tables of 256 addresses each are
accepted. The container image runs it with `node dist/src/sandbox/index.js`.

### Check your own policy without running a server

```
npm run check -- --policy my-policy.json --tx <base64 transaction>
npm run check -- --policy my-policy.json --tx-file tx.b64 --spent native=2000000000
npm run check -- --policy my-policy.json --evm-tx tx.json
```

`check` runs the same decoder and policy evaluator as the server on one transaction and prints the decision, the
reasons, and the decoded instructions. The exit code is 0 for ALLOW, 2 for NEEDS_REVIEW and 1 for bad input, so it
can gate a CI job. It validates the policy file first and lists every problem in it, and it warns about settings
that make every payment wait for a person (for example an empty `destinationAllowlist` without
`allowAnyDestination`). `--spent` says how much has already been spent today, so you can test the daily limit.
A Solana transaction that uses an Address Lookup Table is held unless `--lookup-tables` supplies the tables,
because `check` has no network. With `--json` it prints the same receipt as the sandbox API.
For the EVM file format see the EVM section below.

A minimal policy:

```json
{
  "policyId": "vendor-payments",
  "programAllowlist": ["11111111111111111111111111111111"],
  "destinationAllowlist": ["<the vendor's address>"],
  "maxAmountPerTransaction": { "native": "1000000000" },
  "maxAmountPerDay": { "native": "5000000000" }
}
```

Amounts are whole numbers in the smallest unit (lamports for SOL), written as strings. Anything not listed is held.

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

### Related policy engines

Real, existing Solana agent-transaction firewalls: [Prflght](https://www.prflght.xyz/)
(program allowlists + on-chain attestation) and [TruCore ATF](https://trucore.xyz/)
(spend caps + a fixed DeFi-venue allowlist) both enforce by blocking
outright on a policy violation. [Privy's policy
engine](https://docs.privy.io/controls/policies/overview) does pre-sign
policy checks in a secure enclave and, per its current docs, also
supports decoding arbitrary custom program instructions via Anchor IDLs.
Parameter-level decoding on Solana is not unique to this project.

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
and returns a link to a self-hosted `/review/:id` page. After a reviewer
signs in there, it shows the review with Approve/Deny buttons; deciding
resolves the review and the page then shows the decision instead. Tested with a fake local Slack-webhook
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
all. The limiter's state persists to SQLite when `persistencePath` is
configured (the same file as the other durable stores), and processes
using that file share its current windows. It does not coordinate across
separate hosts or separate disks; that deployment shape needs a shared
backing store.

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

**Version-1 transactions carry their priority fee outside the instructions.**
Replaying real mainnet transactions (35% of non-vote transactions in a
2026-10-18 sample were version 1) showed that a v1 message declares its
compute settings and priority fee in its own config instead of ComputeBudget
instructions. Measured on five mainnet transactions, the fee charged equals
5000 x signatures + that `priorityFee`, paid by the fee payer. Instruction
checks alone never saw it, so a v1 transaction could be ALLOWed while setting
a large priority fee that a Kora fee payer would then pay. The parser now reads
it into `priorityFee`, and `Policy.maxPriorityFeePerTransaction` (lamports)
caps it. If a v1 transaction sets any priority fee and the policy defines no
cap, it goes to review rather than being ignored. A transaction with no
instructions at all also goes to review instead of passing vacuously.

Two demo scripts prove this catches things the raw_dump/program-allowlist
checks do **not**: `demo/unapproved-destination-payment.ts` is a fully,
cleanly decoded transfer -- no hidden instruction, nothing a
discriminator check would flag -- to a destination that isn't an
approved vendor, and it's still correctly blocked. `demo/over-limit-payment.ts`
is the same, for an amount over the per-transaction cap. Daily-limit
tracking is real too, via `DailySpendTracker` (persists to SQLite when
configured, so a restart mid-day doesn't silently reset the budget) --
only transactions that were actually `ALLOW`ed count against the day's
budget, wired in at the server layer so the policy evaluator itself
stays a pure, testable function.

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
do over time, not just a stateless pass/fail gate. `EvaluationLog`
persists to SQLite when configured, same as the other stores here --
the query interface is written so a different database could replace
SQLite later without changing callers.

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

Every instruction in the proposal is reported, not just the first
upgrade. Each `Upgrade` gets its own verification history and buffer
fingerprint, and the other instructions are listed by program, so an
upgrade cannot hide a vault transfer in the same proposal. A proposal
with no upgrade that changes a program's or buffer's upgrade authority
(`SetAuthority`, `SetAuthorityChecked`) or closes one (`Close`) returns
`CONTROL_CHANGE` with the account and the new authority or recipient
named, because handing over the upgrade authority is as consequential
as an upgrade.

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
become `UNKNOWN` with an explanatory reason, rather than a "no verified-build
record." The configured cluster is included in the response so a
caller can see what the on-chain read and the verification check were
each attributed to.

Scope limit: even a
`VERIFIED` outcome reports whether the program has *any* verified-build
record on file, not a live cryptographic proof that the *specific
pending buffer* matches it byte-for-byte. `getBufferBytecodeEvidence`
now computes that buffer's own executable hash directly -- the on-chain
`UpgradeableLoaderState::Buffer` layout (a four-byte bincode enum
discriminant, then an `Option<Pubkey>` authority tag) is read precisely,
trailing zero-padding stripped, and the result SHA-256 hashed -- but
this is still a fingerprint for a human to compare against a separately
trusted deterministic build, not a verified-build proof on its own:
OtterSec's public API documents verification status by deployed program
ID, not pending buffer ID, so there's no live service to check the
fingerprint against automatically. Every upgrade this detects returns
`NEEDS_REVIEW`, never an autonomous `ALLOW`, regardless of verification
outcome; it hands a human real context where today they'd see nothing
at all, not a cryptographic guarantee it doesn't yet have.
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

Run `npm run build`, `npm run lint` and `npm test` to verify the current checkout.
Report the totals from that run, including skipped tests. The suite covers decoding,
policy evaluation, authenticated review, persistence, audit events and signing
boundaries, using serialized transactions, fixtures and local fake-service HTTP
servers. The Kora and Turnkey stand-ins exercise API behavior without contacting
those providers. OtterSec responses are supplied through an injectable fetch boundary.
Ethereum fork tests require `EVM_FORK_RPC`; without it they are skipped.

The historical Kora runs described above do not establish the state of a current
deployment. Repeat integration checks against the intended environment before enabling
signing. See "Known limitations" and the Turnkey section for outstanding validation.

## Nemotron reviewer assist (Nebius x NVIDIA Global AI Hackathon)

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
- **Never blocks.** The `/evaluate` response does not wait on the model. A
  missing key, timeout, non-200 or malformed reply simply means no note.
- **No secrets in logs.** Errors log the HTTP status or error name only.

Configuration (all optional; unset means no AI note):

| Variable | Meaning |
|---|---|
| `NEBIUS_API_KEY` | Token Factory API key |
| `NEBIUS_MODEL` | Nemotron model id. Required if the key is set. List candidates with `NEBIUS_API_KEY=... node scripts/list-nebius-models.mjs` |
| `NEBIUS_BASE_URL` | Defaults to `https://api.tokenfactory.nebius.com/v1` |

## Customer onboarding

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
- **Revoking is safe.** `revoke` stops all of a customer's keys; the server stays in key mode
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

**Compatibility change:** review links keep working, but holding a link no longer reveals anything. Before
sign-in, `/review/:id` returns the same sign-in page, byte for byte, for any id, real or not. The review is
loaded only after sign-in, from `GET /operator/api/reviews/:id`, with the same customer scoping as the queue.
Approve and deny are still the `POST /review/:id/approve` and `/deny` actions, unchanged: the page calls them
with the token in a header and `Accept: application/json`, and gets an explicit answer for its own request:
`200 {"outcome":"applied"}` if this request made the decision, `409 {"outcome":"already_decided"}` if someone
else (or an earlier request) decided it first, and `410 {"outcome":"expired"}`. Only the applying request is
credited, recorded in the audit log and acted on; whether it applied comes from the same database transaction as
the change, so concurrent reviewers, even on separate server processes, cannot both get "applied". Other clients,
including older ones that post a `token` or `secret` form field, keep the original answers: a redirect to the
review, or 410 once it has expired. A server
with no reviewer and no shared secret now shows no review on the page at all; the agent's own
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
audit trail's signing events. It runs on startup, twice safely. Old reviews keep no chain ("unknown"); nothing
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
- **It is single use.** The approval is spent atomically before signing, so two simultaneous requests
  sign once. If signing fails the approval is given back (the same message always produces the same
  transaction, which the chain accepts once).
- **It expires.** It is usable for one review window (`REVIEW_EXPIRY_MS`, default 15 minutes) after approval.
- **It belongs to the customer.** Another customer's `reviewId` looks like a missing one (404).
- **It counts toward the daily spend cap**, like an ALLOW.
- Errors: 404 `REVIEW_NOT_FOUND`, 409 `REVIEW_NOT_APPROVED` / `REVIEW_ALREADY_USED` / `REVIEW_STALE`.

The status endpoint returns decision metadata only, never the transaction. An unexpected server error returns
a generic 500 (`INTERNAL_ERROR`) and signs nothing.

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
instruction names the fee payer, so the relayer's own balance cannot be spent or used to fund new accounts.
Before onboarding a customer, check that (a) the agent's own key cannot submit a transaction without the
relayer's signature, (b) the relayer is not exposed to the agent except via this service, and (c) a test
transaction sent around the gate fails. This is a property of their setup that we verify with them; no code
in this repository can establish it.

**What is verified.** The registry loaded by the entrypoint covers System transfers, SPL Token and Token-2022
`TransferChecked`, `closeAccount` and `syncNative`, ComputeBudget, and exact-in Jupiter v6 swaps (see
"Swaps (Jupiter)" below). Anything else (other token instructions, other programs) is not decoded and goes to review. Token payments are limited by mint: put the mint address
in `maxAmountPerTransaction` and `maxAmountPerDay`. A token with no configured limit goes to review, as does a
value-moving asset of any kind with no limit. The destination of a token payment is the receiving token
account, not its owner, so a destination allowlist lists token accounts.

**Priority fees.** A fee set through ComputeBudget (legacy and v0) or the message config (v1) is computed and
compared with `maxPriorityFeePerTransaction`; with no limit set any non-zero fee goes to review. The
computed fee matched the fee charged on chain for 300 of 300 real mainnet transactions
(`scripts/verify-priority-fee.mjs`). A transaction made only of compute settings goes to review.

**Spend accounting.** `/evaluate` is a preview and spends nothing; pass `"reserve": true` to charge the
daily budget when you sign somewhere else. `/gate-and-sign` reserves the budget. If signing fails before
anything is sent (a fee-payer mismatch, or a simulation Kora refused) the reservation is refunded to the day it was made. If it fails in
any other way the transaction may have been broadcast, so the response says `outcome: "UNKNOWN"` and the
budget stays reserved until that day ends: over-counting is safe, refunding money that may have moved is not.
There is no automatic reconciliation against chain status yet.

## Human review on Solana needs a durable nonce

An approval is bound to the exact transaction, and a Solana transaction built with a recent blockhash stops
being accepted soon after: on devnet on 7 November 2026 a blockhash was accepted at 31 seconds and refused at
43. Reviews last up to 15 minutes. Run through the real review flow against a live Kora on devnet, an approval
given after 90 seconds was refused with "Blockhash not found". So a transaction that may go to review must use a
durable nonce: a nonce account whose stored value takes the place of the blockhash and stays valid until the
transaction uses it, which can happen only once.

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

**Finding waiting requests.** Turnkey documents a page size (1 to 100, default 10) and an `after` cursor (an
activity id), but not the order of results, how the list ends, or whether a short page is the last one. So
AgentGuard asks for 100 at a time and treats only an empty page as the end. A page that brings nothing new also
stops the scan: if it ends at the cursor, it is taken as the end; if not, the cursor is not moving, so the next scan
starts again from the top. Each poll reads at most 20 pages (2,000 requests); the next poll carries on from where the
last one stopped, and wraps to the top after the end. So every waiting request is reached within a few polls,
however long the list. If a page request fails, the next poll retries from the same place; if it fails twice there
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
- **The tradeoff.** A charge kept this way can overcount the day's spending until the day ends. It never
  undercounts it. The page says so.
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

Also changed: an instruction that names a destination but moves no amount (such as creating a token account for
someone) is now checked against `destinationAllowlist`. Before, only instructions with an amount were.

## Swaps (Jupiter)

AgentGuard reads Jupiter v6 exact-in swaps: `route`, `shared_accounts_route`, `route_v2` and
`shared_accounts_route_v2`. In a sample of 26 recent successful mainnet Jupiter transactions, 13 used `route_v2`,
8 `route` and 5 `shared_accounts_route`. The decoder uses Jupiter's IDL as fetched from chain (pinned by SHA-256
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
net change per asset. Checked against real mainnet Jupiter swaps on 7 November 2026: those that still executed
passed with the fee as the only difference, and those that no longer could went to review. One limit: the "before"
state is read a moment ahead of the simulation, so funds arriving in the signer's accounts in between could mask an
equal loss of the same asset. Using it means sending the agent what is taken, at that moment.

What is not checked: there is no live price feed, so without `minOutPerIn` a swap is bounded only by the
agent's own quote and slippage, which a compromised agent controls. Set a floor for every pair you allow.
Exact-out and token-ledger routes go to review. Swaps should be decided automatically: a human review takes
longer than a quote or a recent blockhash stays valid.

## EVM (Ethereum) gate

An experimental second path for EVM chains, using the same policy object, review queue, evaluation log and
daily-spend tracker as Solana. It is built and tested, and every part of it is **off unless you turn it on**
with the environment variables below (or with `createServer(..., { evmSigner, evmCodeLookup, evmBroadcaster })`
when embedding). No customer uses it yet, and it has no custody story beyond the signer you plug in.

| Variable | Effect |
|---|---|
| `EVM_RPC_URLS` | JSON object of chain id to http(s) RPC URL, e.g. `{"1":"https://..."}`. Turns on the destination code check. Invalid JSON or URLs stop startup. |
| `EVM_BROADCAST=true` | Lets `/gate-and-sign-evm` send transactions itself (`broadcast: true`). Needs `EVM_RPC_URLS`. |
| `EVM_LOCAL_KEY_HEX` + `EVM_ALLOW_LOCAL_KEY=true` | A signing key held in this process, for tests and supervised pilots. Refused without the allow flag, and refused outright when `AGENTGUARD_PRODUCTION=true`. Startup prints the address, never the key. |

With no signer configured, `/gate-and-sign-evm` answers 503. Production deployments therefore have no EVM
signing until a custody signer (see `EVM_Signer_Decision_Brief.md` in the fundraising folder) is built behind the
`EvmSigner` interface.

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
delegate is in `trustedDelegates`, a contract in neither allowlist goes to review, and code it cannot read
goes to review. Without a lookup this check is off.

**Signing.** `evmSigner` is an interface. `LocalKeySigner` holds a key in memory and is for tests and supervised
pilots only; it is not custody (see `EVM_Signer_Decision_Brief.md` in the fundraising folder for the options).
`/gate-and-sign-evm` returns the signed bytes. With `broadcast: true` (needs `evmBroadcaster`, for example
`rpcBroadcaster`) the server keeps the bytes, re-reads the destination code uncached just before sending, and
returns the transaction hash. If the destination changed it answers 409 and sends nothing; if the node fails it
answers 502 and keeps the budget and approval spent because the outcome is unknown.

**What it does not do.**

- It does not check prices or slippage beyond refusing a zero minimum output, and it does not support swaps paid in ETH.
- Uniswap is recognised on Ethereum mainnet only; other chains' routers have not been verified.
- The code check sees the chain at one moment. Broadcast mode narrows the gap to seconds; only on-chain
  enforcement (a smart account) closes it.
- The fork tests (below) are the only checks against a real chain, and they were last run together before the
  latest changes. The code-check and broadcast paths have been tested with stubs, not against a node.

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
  reviewer, there is no second factor, no token expiry or rotation, and the
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
  It also depends on Node's built-in `node:sqlite` module, which Node itself
  still flags as experimental (confirmed: every run prints
  `ExperimentalWarning: SQLite is an experimental feature and might change
  at any time`) -- real and working today, verified with an actual process
  restart and two separate OS processes writing concurrently
  (`test/persistence.test.ts`), but worth knowing the underlying API isn't
  Node's own stable surface yet.
- **`npm audit` currently reports 12 inherited advisories** (6 moderate,
  6 high; see "Dependency advisories" below), through the Solana SDK dependency graph: `@solana/web3.js`,
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

`npm audit` reports 12 advisories (6 high, 6 moderate) that have no safe fix today. We did not force the
upgrades `npm audit fix --force` offers, because they are major version changes (for example downgrading
`@sqds/multisig`). Where each one comes from, by reading which of our own files import the package
(`grep`, not a full reachability analysis):

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

Re-run `npm audit` before each release. The `body-parser` advisory (a denial of service through a request body
with trailing bytes after compression) and the `qs` advisory (fixed in 6.16.2) are fixed in this version.

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
way). Approve/deny needs a registered reviewer token
(`scripts/reviewers.mjs`, run against the same `AGENTGUARD_DB_PATH`) or the legacy
`REVIEW_ACTION_SECRET`; with neither, reviews cannot be read or decided from the review pages. Set
`REVIEW_REQUIRE_REVIEWERS=true` to ignore the shared secret once reviewers exist. `REVIEW_EXPIRY_MS` defaults to 900000
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
current working directory. `AGENTGUARD_RETENTION_DAYS` (default `30`, or `off`)
deletes evaluation history and reviews older than that many days, hourly and in
small batches. Without it the file grows without bound: measured at about 7.7 KB
per request, 7.7 GB for one million `/evaluate` calls. Deleting rows does not
shrink the file, it lets SQLite reuse the space. Deleted reviews take their
approver attribution with them, so export it first if you need a longer audit
trail. Node 22.13 or newer is required for Node's built-in
SQLite module. When `SOLANA_CLUSTER=mainnet-beta`, startup requires the RPC
endpoint's measured genesis hash to be mainnet-beta before serving requests.
Set `REQUIRE_RPC_NETWORK_MATCH=true` to apply the same refusal behavior to a
configured devnet or testnet deployment. An RPC identity failure or mismatch
under strict matching prevents the HTTP server from starting.

### Container

The image runs as the unprivileged `node` user and writes SQLite state to
`/data/agentguard.sqlite`. Mount `/data` on persistent storage. The health
probe is `GET /healthz`; it returns only `{ "status": "ok" }` and does not
expose configuration or secrets.

```bash
docker build -t agentguard .
docker run --rm -p 8787:8787 -v agentguard-data:/data \
  -e RPC_URL=https://api.mainnet-beta.solana.com \
  -e SOLANA_CLUSTER=mainnet-beta \
  -e BASE_URL=https://agentguard.example.com \
  -e REVIEW_ACTION_SECRET=replace-with-a-long-random-secret \
  agentguard
```

### EVM fork test

`test/evm-fork.test.ts`, `test/evm-permit-fork.test.ts` and `test/evm-sign-fork.test.ts` and `test/evm-swap-fork.test.ts` (real Uniswap SwapRouter02 swaps) send real transactions (native transfer, USDC transfer/approve, WETH deposit, NFT `setApprovalForAll`, `transferFrom`) and submit real signed permits (USDC EIP-2612, Permit2 `PermitSingle`) on a forked mainnet and checks that what the decoder reports is what moved on chain. It is skipped unless `EVM_FORK_RPC` points at an anvil node, for example `anvil --fork-url <mainnet rpc> --fork-block-number <n>`.

The fork tests share one node. Run them with `--test-concurrency=1` if you add tests that touch the same accounts. `evm-sign-fork.test.ts` asks the gate to sign transactions and broadcasts exactly the returned bytes.
