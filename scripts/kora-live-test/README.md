# Kora live-signing proof scripts

Manual, one-off proof scripts, not part of the automated test suite or
the demo/pitch materials. They prove AgentGuard's decode-and-policy code
can drive a real, locally running Kora relayer end to end: real decode,
real policy evaluation, real Kora signing, real submission, real
on-chain confirmation.

Both were run and independently verified (balances checked directly
against the chain before and after, not just trusting the script's own
output) on 2026-10-07: once on devnet, once on real mainnet with a
small real amount. See `README.md`'s Kora gate section for the mainnet
transaction signature.

## Setup, both scripts

1. Install Kora: `cargo install kora-cli` (requires Rust/cargo).
2. Build this repo: `npm run build` (from the repo root).
3. Create a `kora.toml` and `signers.toml` for whichever cluster you're
   testing. There is no checked-in example config in this directory,
   Kora's schema is particular (it requires a payment token configured
   even for free sponsorship, and the `[validation.price]` table must
   come after the other `[validation]` keys in the file or TOML parses
   it into the wrong section). Start from
   `https://raw.githubusercontent.com/solana-foundation/kora/main/kora.toml`
   and run `kora config validate` before starting the server; its own
   validator catches most mistakes, including real security ones (it
   will warn, correctly, if the fee payer is allowed to be a System
   Transfer source -- it shouldn't be, see below).
4. Run `kora rpc start --config kora.toml --signers-config signers.toml
   --rpc-url <cluster RPC URL>` with the signer's private key set via
   whatever env var `signers.toml` names.

## devnet-test.mjs

Safe to run freely. Generates a persistent throwaway test wallet on
first run (saved next to this script, gitignored, never committed) and
reuses it afterward. Needs free devnet SOL at the printed address
(faucet.solana.com) before it can do anything.

## mainnet-test.mjs

**Moves real money. Run this yourself, don't hand it to an AI session
to execute.** Reads a private key from a local file
(`~/mainnet-agent-key.txt` by default, override with `AGENT_KEY_PATH`)
that you create yourself, prints both balances and exactly what it's
about to send, and pauses 5 seconds before doing anything so you can
Ctrl+C. Keep the test amount small; it's a wiring proof, not a real
payment.

## Why the fee payer can't also be the transfer source

Kora's signing model: whichever signer is configured in `signers.toml`
acts as the transaction's fee payer, a separate role from whoever
authorizes the actual transfer. The agent (or whatever wallet is
spending its own funds) signs for that separately. If the fee payer is
also allowed to be a System Transfer source, Kora's own validator warns
about exactly why: a malformed or malicious request could drain the fee
payer's own balance via the sponsorship mechanism itself. Both scripts
build the transaction with Kora's signer as `payerKey` only, and the
agent wallet as a separate instruction-level signer for the transfer, by
design, not as an afterthought.
