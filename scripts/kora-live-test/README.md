# Manual Kora integration checks

These scripts exercise a separately configured Kora relayer. They are not part of
the automated suite and do not establish production readiness or current deployment
status. Run commands from the repository root after `npm run build`.

## Devnet

`node scripts/kora-live-test/devnet-test.mjs` generates a local test wallet and
requires devnet SOL and a running Kora instance at `http://localhost:8080`. The
generated wallet file is ignored by Git. Use devnet credentials only.

## Mainnet

`mainnet-test.mjs` transfers real SOL. It is an operator-run utility, not a demo or
automated verification command. Read the script and check the destination, amount,
RPC and Kora configuration before running it. Set `AGENT_KEY_PATH` to a protected
local key file. Never paste private keys into shell commands, logs or source files.

## Relayer configuration

Configure Kora independently using its version-matched configuration and signer
files. The agent authorizes the transfer; the relayer supplies the fee-payer
signature. The relayer's signing key must not be available to the agent. Verify
that agent requests cannot use the relayer as a transfer source.

These utilities evaluate a transaction and then call Kora directly. They do not
exercise the authenticated AgentGuard HTTP signing route, customer revocation,
human approvals or recovery after uncertain submission. Use the relevant
integration tests and a supervised environment for those checks.
