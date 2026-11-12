# AgentGuard

<img src="assets/agentguard-logo.svg" width="96" alt="AgentGuard logo">

Transaction policy checks and human approval workflows for Solana and EVM agents.

AgentGuard decodes supported transaction instructions, checks them against a configured
policy, and returns `ALLOW` or `NEEDS_REVIEW`. Signing integrations can require a
reviewer's approval before submitting a transaction. Unknown or unsupported instructions
are referred for review. Invalid requests and authorization failures return errors.

The Solana decoder uses
[`solana-clear-sign`](https://github.com/mjordan237/solana-clear-sign), pinned to a
commit in the lockfile. AgentGuard adds policy evaluation, review workflows, spend
accounting and signing integrations.

## Start locally

Use Node.js 22.19 or newer for the documented workflows.

```bash
npm ci
npm run build
npm run quickstart
```

The quickstart starts a local service and uses a stand-in relayer that returns fake
signatures. It demonstrates allowed payments, transactions held for review, reviewer
authentication and single-use approvals. It does not submit transactions to a chain.
Follow the printed review link and use the temporary demo reviewer token.

For an automated local walkthrough:

```bash
npm run quickstart -- --auto-approve --exit
```

## Components

| Component | Purpose |
|---|---|
| Policy engine | Program and destination allowlists, per-asset limits, daily budgets and supported swap checks |
| Review queue | Authenticated reviewer access, customer scoping and transaction-bound approvals |
| Solana integration | Supported instruction decoding and optional Kora relayer submission |
| Turnkey integration | Required-approver workflow, durable activity records and reconciliation of uncertain vote outcomes |
| EVM integration | Transaction and permit evaluation; optional signing through an `EvmSigner` implementation |
| Audit and storage | SQLite persistence, customer audit chains and a consistent backup command |
| Preview tools | Offline CLI and a separate HTTP policy playground that cannot sign |

Policy approval, reviewer approval, signing and on-chain execution are different events.
An `ALLOW` result or completed Turnkey vote does not prove that a transaction executed.

## Choose a workflow

- **Run the sample scenarios:** see the [local demo guide](demo/README.md).
- **Evaluate a policy locally:** use the [offline CLI](docs/policy-preview.md#offline-policy-checks).
- **Explore request formats:** run the [preview server](docs/policy-preview.md#preview-server).
- **Integrate policy checks over HTTP:** use the [developer API guide](docs/developer-api.md).
- **Integrate an agent:** see the [request flow and TypeScript client](docs/integration-and-operations.md#integrating-an-agent).
- **Configure customers and reviewers:** see [customer onboarding](docs/integration-and-operations.md#customer-onboarding).
- **Connect a signing provider:** read the [Solana requirements](docs/integration-and-operations.md#human-review-on-solana-needs-a-durable-nonce), [Turnkey workflow](docs/integration-and-operations.md#turnkey-wallets-agentguard-as-a-required-approver) or [EVM reference](docs/integration-and-operations.md#evm-ethereum-gate).
- **Operate the service:** see [production configuration](docs/integration-and-operations.md#running-it-in-production), backups and [container requirements](docs/integration-and-operations.md#container).

These instructions describe the repository. They do not establish that a hosted API
is deployed with this revision or configured for production signing.

## Deployment boundaries

AgentGuard protects only signing paths that require it. An agent with another usable
signing key or a wallet policy that bypasses the gate can submit outside this service.

Before exposing the signing service, enable `AGENTGUARD_PRODUCTION=true`, configure
API-key authentication, named reviewers, persistent storage, HTTPS and trusted proxy
settings. The preview server is a separate service with its own authenticated
production configuration. See the [developer API guide](docs/developer-api.md) and
operations reference for the required variables.

Run one active Turnkey approver process. The SQLite lease and fencing checks do not
provide exactly-once external submission or complete safety across multiple replicas.
A request already in flight can finish after takeover. Real-organization validation
of Turnkey vote and replay behavior remains required before production signing.

The bundled EVM local-key signer is for tests and supervised pilots and is refused
in production mode. Production EVM signing requires a validated custody integration.
Spend accounting is not an on-chain settlement ledger; uncertain outcomes retain
charges and require reconciliation. Review the remaining
[limitations and dependency audit notes](docs/integration-and-operations.md#known-limitations).

## Development

```bash
npm run build
npm run lint
npm test
```

The default suite includes tests with local fakes. EVM fork suites require
`EVM_FORK_RPC` and are skipped when it is unset; see the
[fork test requirements](docs/integration-and-operations.md#evm-fork-tests).

| Directory | Contents |
|---|---|
| `src/policy/` | Policy schema, evaluation and spend accounting |
| `src/agent-integration/` | Solana parsing and decoder registry |
| `src/api/` and `src/client/` | Signing-service HTTP routes and TypeScript client |
| `src/escalation/` | Review storage, authentication and operator pages |
| `src/turnkey/` | Turnkey client, activity lifecycle and approver |
| `src/evm/` | EVM decoding and signing interfaces |
| `src/sandbox/` and `src/cli/` | Preview server and command-line tools |
| `test/` | Unit and integration tests |
| `demo/` and `examples/` | Demonstrations and integration examples |

## License

[Apache License 2.0](LICENSE).
