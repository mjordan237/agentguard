# AgentGuard -- technical walkthrough script

Target length: 5-8 minutes, for judges who want to see the real code and
architecture, not just the pitch narrative. Every command below actually
runs against this repo -- run `npm install && npm run build` first.

---

## 1. The pipeline (30 seconds)

```
Agent constructs a transaction
  -> POST /evaluate or /gate-and-sign {agentId, policyId, transactionBase64}
  -> parseAndDecodeTransaction() -- @solana/web3.js parses the tx, resolves
     any Address Lookup Tables via real RPC (fails closed if unresolvable)
  -> for each instruction: look up the program in the IDL registry,
     resolve the instruction name from its discriminator
  -> decodeVerifiedInstruction() (solana-clear-sign) -- binds the IDL's
     cryptographic digest to the observed program ID before decoding
  -> evaluatePolicy() -- program allowlist, destination allowlist,
     per-transaction and daily spend limits
  -> ALLOW: recorded, and (on /gate-and-sign) forwarded to Kora's real
     signTransaction JSON-RPC method
  -> NEEDS_REVIEW: recorded, posted to Slack, routed to a self-hosted
     approve/deny page -- never reaches a signer
```

Point out: this is deliberately a two-outcome pipeline, not three.
`evaluatePolicy` never produces an autonomous `DENY` -- an anomaly
always routes to a human via `NEEDS_REVIEW`. Nothing here silently
blocks a transaction without a person seeing it.

## 2. The decode itself (1-2 minutes)

Open `src/agent-integration/decode.ts` and `demo/policy.ts`. Show the
registered IDL for `SystemProgram.transfer` -- only `transfer` is
registered, deliberately, so an injected instruction from the same
program (`Assign`) has no entry to match and falls to `raw_dump` instead
of being silently ignored.

Run the adversarial demo live:

```bash
node dist/demo/adversarial-payment.js
```

Point at the real output: a legitimate-looking `transfer` decoded
cleanly, sitting right next to an `unknown (raw_dump)` instruction with
the reason "No instruction in the registered IDL matches this data's
discriminator." Decision: `NEEDS_REVIEW`. This is the core claim of the
project made concrete -- a program-allowlist check alone would have let
this straight through, because both instructions touch the same
allowed program.

## 3. Destination and spend-limit enforcement (1 minute)

```bash
node dist/demo/unapproved-destination-payment.js
node dist/demo/over-limit-payment.js
```

Both of these decode *cleanly* -- no hidden instruction, nothing a
discriminator check would catch. They're blocked purely on policy:
destination not on the approved-vendor list, and amount over the
per-transaction cap. This is the second half of the pitch: decoding
correctly isn't the same question as deciding whether something should
be allowed.

## 4. Human escalation, for real (1 minute)

Start the server (`PORT=8787 SLACK_WEBHOOK_URL=... node dist/src/index.js`)
and walk through `test/escalation.test.ts` conceptually: a real local
HTTP server standing in for Slack, a real fetch to the Incoming Webhook,
a real GET to `/review/:id` showing the pending state, a real POST to
`/review/:id/approve`, and a re-render showing `APPROVED` with the
buttons gone. Nothing here is asserted against a mock -- it's a real
HTTP round trip end to end.

## 5. Gating Kora -- the "sits on top of, doesn't compete with" proof (1-2 minutes)

Open `src/gateway/kora-gate.ts` and `src/api/server.ts`'s
`/gate-and-sign` handler. Walk through `test/kora-gate.test.ts`: a real
local server speaking Kora's actual JSON-RPC wire format (verified
against `@solana/kora`'s own type declarations, not guessed), asserting
that an `ALLOW`ed transaction gets forwarded to Kora's `signTransaction`
method exactly once, and a `NEEDS_REVIEW` transaction never reaches Kora
at all. Also show the failure modes: a Kora-side error returns
`KORA_SIGNING_FAILED`, never a false `ALLOW`; no Kora configured returns
`KORA_NOT_CONFIGURED` rather than silently skipping the sign step.

Say explicitly: Kora is the Solana Foundation's own relayer, and it
already does coarse program allowlisting -- it doesn't do
authenticated-IDL, argument-level decoding. That's the gap AgentGuard
fills, and this is the same shape it would take in front of Turnkey,
Privy, Crossmint, or Coinbase's wallet infrastructure.

## 6. Observability (30 seconds)

```
GET /agents/:agentId/history
GET /transactions/:id
```

Every `/evaluate` call is logged, `ALLOW` decisions included -- not just
the flagged ones. This is what turns AgentGuard from a one-shot pass/fail
gate into an actual record of what an agent tried to do over time.

## 7. Close honestly

`npm test` -- 62 tests, all exercising real code paths: real
transactions, a real local HTTP server, a real fake-Slack-webhook
receiver, a real fake-Kora-RPC server, a real locally-constructed
Address Lookup Table, and real SDK-serialized Squads `VaultTransaction`
and `Proposal` accounts (see README's Squads upgrade gate section for
what that covers). Point to the README's Known Limitations section
unprompted: the review link is a bearer token today, not yet
authenticated; storage is in-memory; running `/gate-and-sign` against a
live Kora node with a real signer, and cryptographically verifying a
pending Squads upgrade buffer's own bytecode, are the two pieces not yet
demonstrated end to end, and that's stated plainly, not glossed over.
