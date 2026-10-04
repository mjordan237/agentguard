# AgentGuard

A security layer for autonomous AI agents that transact onchain.
AgentGuard sits between an agent and its wallet: it verifies transaction
intent, simulates and decodes what a transaction actually does, enforces
policy, and blocks or routes to a human before funds move. It doesn't
compete with wallet providers like Coinbase, Turnkey, or Crossmint --
it's the security layer that sits on top of them.

Starting on Solana. The policy-and-decode engine underneath this repo is
called ClearSign, built on
[`solana-clear-sign`](https://github.com/mjordan237/solana-clear-sign)'s
authenticated-IDL, bounds-checked instruction decoder.

Built for Colosseum's Crypto World's Fair hackathon (Solana Ecosystem
track, deadline Oct 12, 2026).

## The idea

An AI agent constructs a Solana transaction -- e.g. paying a vendor for
completed maintenance work, or settling an [x402](https://solana.com/x402)
agentic payment. Before it signs, AgentGuard's ClearSign engine decodes
exactly what the transaction does (reusing `solana-clear-sign`'s
authenticated-IDL, bounds-checked decoder), checks it against a policy
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
(spend caps + a fixed DeFi-venue allowlist). [Privy's policy
engine](https://docs.privy.io/controls/policies/overview) does pre-sign
policy checks in an enclave but only parses native System/Token
instructions on Solana, not arbitrary IDLs.

None of them do **authenticated-IDL, parameter-level decoding** of
arbitrary programs. Allowlisting a program ID doesn't stop a
prompt-injected agent from calling `SetAuthority` or `Approve` on an
otherwise-trusted program -- you have to actually decode the instruction
arguments to catch that. That's what `solana-clear-sign` already does,
and what this project builds a policy and escalation layer on top of.

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
do over time, not just a stateless pass/fail gate -- see
[`clearsign-risk-summarizer`](../clearsign-risk-summarizer)'s README for
why this matters beyond this hackathon: it's the observability
substance a Nosana-funded "agent transaction safety infrastructure"
pitch needs, not just a documentation claim. In-memory today
(`EvaluationLog`), same as the other stores here -- the query interface
is written so a real database can replace the storage later without
changing callers.

**`POST /gate-and-sign` gates Kora, the Solana Foundation's own relayer,
and is real and tested** (`src/gateway/kora-gate.ts`). Kora already does
program allowlisting and per-instruction-category fee-payer permissions
natively, but not authenticated-IDL argument-level decoding -- that's the
gap this fills. The flow: an agent's transaction goes through the same
decode-and-policy check as `/evaluate`; only on `ALLOW` is it forwarded
to Kora's real `signTransaction` JSON-RPC method (`@solana/kora`'s actual
client, talking real JSON-RPC 2.0). A `NEEDS_REVIEW` decision is blocked
before Kora is ever called -- tested by counting real RPC calls against a
local server speaking Kora's actual wire format, not by asserting on a
mock. A Kora-side failure returns `KORA_SIGNING_FAILED`, never a false
`ALLOW`; no `KORA_RPC_URL` configured returns `KORA_NOT_CONFIGURED`
rather than silently skipping the sign step.

Honest caveat: the fake server in `test/kora-gate.test.ts` speaks Kora's
real JSON-RPC method names and request/response shapes (verified against
`@solana/kora`'s own type declarations), but this hasn't yet been run
against an actual `kora rpc` process with a live signer -- that requires
a running Rust binary and a funded fee payer, which is real setup, not
something to claim without doing it.

**`POST /squads/upgrade-check` is a second, narrower gate: a Squads V4
multisig program-upgrade proposal, checked against its verification
history, real and tested** (`src/gateway/squads-upgrade-gate.ts`). The
gap this targets is different from Kora's: Squads' own documentation
tells signers to manually run `solana-verify` themselves and compare
hashes by hand before approving an upgrade -- nothing in Squads' UI
surfaces build-verification status at the point of signing. Given a
multisig and a pending transaction index, this reads the real on-chain
`VaultTransaction` account (via `@sqds/multisig`), scans its compiled
instructions for a genuine BPF Upgradeable Loader `Upgrade` instruction
(discriminator and account order verified against the real
`solana-loader-v3-interface` enum, not guessed), and -- if found --
checks the target program's verification history against OtterSec's
real, live `verify.osec.io` API.

Honest scope limit, stated plainly rather than implied away: this
reports whether the program has *any* verified-build record on file, not
a live cryptographic proof that the *specific pending buffer* matches
it byte-for-byte. Doing that would mean computing the buffer account's
own executable hash directly, and the exact on-chain byte layout for
that wasn't confirmed precisely enough here to do safely -- guessing at
it risked a silent, wrong hash that looks correct. Every upgrade this
detects returns `NEEDS_REVIEW`, never an autonomous `ALLOW`; it hands a
human real context where today they'd see nothing at all, not a
cryptographic guarantee it doesn't yet have. `test/squads-upgrade-gate.test.ts`
tests discriminator/account-order parsing with a real, SDK-shaped
instruction and checks real, live `verify.osec.io` responses for both a
known-verified program and one with no record. `test/squads-upgrade-endpoint.test.ts`
builds a real `VaultTransaction` account, serializes it through
`@sqds/multisig`'s own beet serializer (not a hand-typed byte buffer),
and feeds those real bytes through the actual deserialization path the
endpoint uses.

Every piece described in this document is real, built, and tested --
there's no remaining "not yet built" list for the code itself; running
the Kora gate against a live Kora node, and computing a pending buffer's
own executable hash for the Squads gate, are the two remaining
real-world steps, both called out above rather than glossed over.
`npm test` runs 29 tests across decode integration, policy enforcement, escalation, ALT
resolution, the observability log, the Kora gate, and the Squads
upgrade gate, all exercising real code paths (real transactions, a real
local HTTP server, a real fake-Slack-webhook receiver, a real
fake-Kora-RPC server speaking Kora's actual wire format, a real
locally-constructed `AddressLookupTableAccount`, a real `VaultTransaction`
serialized through `@sqds/multisig`'s own serializer, and real live
calls to `verify.osec.io`) rather than mocks.

## Known limitations

Honest, not hidden -- these are hackathon-scale tradeoffs, not bugs
discovered after the fact:

- **The `/review/:id` approve/deny link is a bearer token, not an
  authenticated action.** `PendingReviewStore` generates an unguessable
  `randomUUID()` per review, but anyone who has that link -- anyone in
  the Slack channel it's posted to, anyone who sees it in a log -- can
  approve or deny the transaction. There's no expiry, no record of who
  actually clicked, and no separate login step. Good enough to prove the
  human-in-the-loop flow works end to end; not what a production
  approval gate for real funds should ship with.
- **No rate limiting on `POST /evaluate`.** Nothing stops the endpoint
  from being hammered, including triggering repeated real Slack posts
  for each `NEEDS_REVIEW` result.
- **Every store is in-memory and resets on process restart.**
  `EvaluationLog`, `PendingReviewStore`, and `DailySpendTracker` all
  hold their state in a `Map`, not a database. The query interfaces are
  written so a real datastore can replace them without changing
  callers, but that swap hasn't happened yet.
- **`npm audit` reports 4 moderate advisories**, all transitive through
  `@solana/web3.js`'s own RPC client (`jayson` -> `stream-json`/`uuid`).
  `npm audit fix --force` would downgrade `@solana/web3.js` to `0.0.3`,
  which isn't a real fix -- these are inherited from the SDK itself, not
  introduced by this code.
- **The Squads upgrade gate checks program verification history, not
  the pending buffer's own bytecode.** It tells a signer whether the
  target program has ever been verified and against what, which is real
  context Squads' own UI doesn't provide today -- but it stops short of
  cryptographically proving the specific proposed buffer matches a
  verified commit byte-for-byte, since that requires computing the
  buffer account's own executable hash and the exact on-chain layout for
  that wasn't confirmed precisely enough here to implement safely.

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
PORT=8787 SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... KORA_RPC_URL=http://localhost:8080 node dist/src/index.js
```

`SLACK_WEBHOOK_URL` is optional -- omit it to run without Slack
notifications (the `/review/:id` approve/deny page still works either
way). `BASE_URL` controls the link posted to Slack and returned in the
API response; defaults to `http://localhost:$PORT`. `RPC_URL` controls
where Address Lookup Tables get resolved from; defaults to
`https://api.devnet.solana.com`. `KORA_RPC_URL` is optional -- omit it
to run `/evaluate` only; set it to a running Kora instance's RPC URL to
enable `/gate-and-sign`, which fails closed with `KORA_NOT_CONFIGURED`
otherwise.
