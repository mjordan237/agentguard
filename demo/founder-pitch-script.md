# AgentGuard: Founder Pitch Script

Target length is 2.5 minutes. Deliver this on camera in your own words,
not read word for word. Every factual claim below matches something
real in this repo. If you want the exact commands and output behind any
of it, that's in `demo/README.md`.

---

**1. Who I am.**

[Fill in your own background here, one or two sentences: what you did
before this, why this problem, why you're the one building it.]

**2. The problem.** AI agents are starting to hold wallets and sign
their own Solana transactions, vendor payments, x402 agentic payments,
multisig approvals. Some custodial wallets now add their own IDL-based
checks, but each one locks you into that provider's engine and its own
gaps, so whether a hidden instruction gets caught depends on which
wallet is underneath. Not theoretical: a USENIX Security 2026 paper
tested 15 production x402 facilitators and found policy violations in
every single one.

**3. What AgentGuard does.** It sits in front of any agent wallet, not
locked into one provider. Before a transaction signs, it decodes the
registered instructions against an authenticated IDL bound to the real
onchain program, so a spoofed IDL can't make a malicious instruction
look benign. It checks that decoded intent against policy and either
lets the transaction through automatically or holds it and routes it to
a structured human review, instead of just blocking it and moving on.
Anything unknown or unverified fails closed to review, never guessed
at. It already gates Kora, the Solana Foundation's own relayer, and
reads live Squads multisig proposals to flag pending program upgrades.

**4. Why Solana.** Solana carries roughly 70% of monthly x402
transaction volume, so agents are already transacting autonomously here
at real scale, which is exactly where this gap matters most.

**5. Who the first users are.** Teams shipping autonomous Solana agent
wallets who need a policy gate in front of signing, and Squads multisig
signers who currently get no automated context before approving a
program upgrade. [Name specific teams or communities you're already
talking to, if there are any.]

**6. What's real today.** This isn't a mockup. 70 automated tests, a
working decode and policy pipeline, a live read of real onchain Squads
proposals. And beyond tests: a real transaction went through the full
pipeline, decoded, policy checked, signed, and submitted by a live Kora
relayer, and it landed and finalized on Solana mainnet. Real money, a
real signature anyone can look up and verify. That's proven, not just
should work. [Cut to the demo video here.]

**7. What's next.** Honestly, nobody outside this repo has used
AgentGuard on a real agent wallet yet. The next milestone is getting it
in front of real agent-wallet builders, running their actual traffic
through it, and finding out where the policy model breaks, rather than
adding more features in isolation. [Replace this with your actual plan
and timeline if it's different.]
