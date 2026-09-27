# ClearSign Agentic Firewall

A policy firewall for AI-agent-constructed Solana transactions, built on
[`solana-clear-sign`](https://github.com/mjordan237/solana-clear-sign)'s
deterministic instruction decoder.

Built for Colosseum's Crypto World's Fair hackathon (Solana Ecosystem
track, deadline Oct 12, 2026).

## The idea

An AI agent constructs a Solana transaction -- e.g. paying a vendor for
completed maintenance work, or settling an [x402](https://solana.com/x402)
agentic payment. Before it signs, ClearSign decodes exactly what the
transaction does (reusing `solana-clear-sign`'s authenticated-IDL,
bounds-checked decoder), checks it against a policy (program allowlist,
destination allowlist, spend limits), and either auto-approves it within
policy or blocks it and routes it to a human with a clear, human-readable
diff of what it actually does -- not what it claims to do.

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
by `?decision=`) plus a running `{total, allow, needsReview, deny}`
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

Every piece described in this document is real, built, and tested --
there's no remaining "not yet built" list. `npm test` runs 17 tests
across decode integration, policy enforcement, escalation, ALT
resolution, and the observability log, all exercising real code paths
(real transactions, a real local HTTP server, a real fake-Slack-webhook
receiver, a real locally-constructed `AddressLookupTableAccount`) rather
than mocks.

## Structure

- `src/policy/` -- policy schema and the allow/deny/needs-review evaluator
- `src/agent-integration/` -- transaction parsing, IDL registry,
  discriminator resolution, the `solana-clear-sign` decode wiring
- `src/api/` -- the agent-facing `POST /evaluate` HTTP API
- `src/escalation/` -- human-in-the-loop approval: pending-review store,
  Slack webhook notification, self-hosted approve/deny review page
- `src/observability/` -- the evaluation log: every `/evaluate` call,
  queryable per-agent, with a running decision summary
- `demo/` -- four end-to-end scenarios for the pitch video: legitimate
  payment, hidden-instruction hijack, unapproved destination, over
  spend limit
- `test/` -- unit and integration tests: policy evaluation, real
  transaction decoding, Slack escalation over real HTTP, Address
  Lookup Table resolution, and the observability log

## Dependencies

Depends on [`solana-clear-sign`](https://github.com/mjordan237/solana-clear-sign),
pinned to a commit via a `github:` dependency. That repo carries a
`prepare` script so its `dist/` actually builds on install -- verified
end to end with a real clean install (`rm -rf node_modules dist
package-lock.json && npm install && npm run build && npm test`, 17/17
pass) against the GitHub dependency, not a local path.

```
npm install
npm run build
npm test
PORT=8787 SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... node dist/src/index.js
```

`SLACK_WEBHOOK_URL` is optional -- omit it to run without Slack
notifications (the `/review/:id` approve/deny page still works either
way). `BASE_URL` controls the link posted to Slack and returned in the
API response; defaults to `http://localhost:$PORT`. `RPC_URL` controls
where Address Lookup Tables get resolved from; defaults to
`https://api.devnet.solana.com`.
