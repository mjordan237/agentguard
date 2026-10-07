# AgentGuard -- pitch script

Target length: 2-3 minutes. Every claim below is backed by something real
in this repo -- see `demo/README.md` for the exact commands and captured
output.

---

**The problem.** AI agents are starting to hold wallets and sign their
own Solana transactions -- paying vendors, settling x402 agentic
payments, executing on-chain trades. Custodial wallet providers are
starting to add their own IDL-based policy checks -- Coinbase's and
Turnkey's both do some parameter-level decoding now -- but each one
locks you into that provider's own policy engine, with its own coverage
gaps (Coinbase's, for instance, only validates primitive parameter
types, and only for API-key-authenticated wallets). A prompt-injected
agent can still append a hidden instruction to an otherwise-legitimate
transaction, and whether it gets caught depends entirely on which
wallet's policy engine happens to be in front of it, and what that
engine does or doesn't cover.

**What AgentGuard does.** AgentGuard sits between an agent and its
wallet. Before a transaction signs, it decodes registered instructions
using an authenticated IDL, cryptographically bound
to the real on-chain program, so a spoofed or mismatched IDL can't make
a malicious instruction render as benign. It checks the decoded intent
against policy: is this program allowed, is this destination approved,
is this amount within the daily budget. If everything checks out, the
transaction proceeds automatically. If anything is off, it's blocked
before signing and routed to a human, with a plain-language diff of what
the transaction actually does, not what it claims to do.

**Show, don't tell.** [Run the four demo scenarios live here.] A
legitimate vendor payment decodes cleanly and goes through. The same
payment with a second, injected instruction -- an authority hijack that
moves zero balance, invisible to any simulator that only diffs balances
-- gets caught and blocked, shown right next to the legitimate transfer,
in the order the agent actually submitted them. A payment to an
unapproved destination gets blocked even though nothing about the
transaction itself looks wrong. A payment over the daily spend cap gets
blocked too.

**We don't compete with wallet infrastructure -- we sit on top of it.**
AgentGuard already gates Kora, the Solana Foundation's own relayer:
transactions we clear get forwarded to Kora's real signing endpoint;
transactions we block never reach it. That's the shape this takes in
front of any agent wallet -- Coinbase, Turnkey, Crossmint, or a custom
signer. This is real, working infrastructure today, not a mockup.

**Why now.** Solana carries roughly 70% of monthly x402 transaction
volume, and a July 2026 USENIX-accepted security paper found policy
violations in every one of 15 production x402 facilitators it tested.
Agents are already transacting autonomously at scale, and the safety
layer for that hasn't caught up. AgentGuard is that layer.
