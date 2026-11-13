# Developer policy API

AgentGuard evaluates a supplied Solana or EVM transaction against a supplied policy.
It returns `ALLOW` or `NEEDS_REVIEW`, reasons, decoded instructions and reproducibility
hashes. This service does not sign, broadcast, open human reviews or maintain a
settled spending ledger. Your application supplies `spentToday` when testing daily
limits and remains responsible for its signing and approval workflow.

## Access and authentication

Obtain the HTTPS service address and a customer API key from the operator. A GitHub
repository URL is not an API address. The address must pass the release checks below
before it is announced as available. No production address is asserted by this guide.

Send the key in `Authorization: Bearer <API_KEY>` to both POST endpoints. Missing,
invalid, revoked-key and revoked-customer requests return `401`. Keep keys on your
backend, outside application source and browser bundles. The documentation playground
accepts a temporary key without saving it to browser storage.

Public discovery endpoints:

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Process health; not a provider or signing readiness check |
| GET | `/v1` | Engine, reported source commit, authentication and limits |
| GET | `/openapi.json` | OpenAPI 3.1 specification, including bearer security |
| GET | `/v1/examples` | Synthetic request bodies and expected decisions |
| GET | `/` | Documentation and interactive playground |

Authenticated endpoints:

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/policies/validate` | Validate `{ "policy": ... }`; inspect `valid` and `problems` |
| POST | `/v1/check` | Evaluate the transaction and policy |

## First integration

Set `AGENTGUARD_API_URL` to the operator-provided origin and provide
`AGENTGUARD_API_KEY` through your secret manager or an interactive environment.
Do not paste a real key into a committed example.

This Node.js example retrieves a complete synthetic request, then evaluates it:

```js
const origin = process.env.AGENTGUARD_API_URL;
const apiKey = process.env.AGENTGUARD_API_KEY;
if (!origin || !apiKey) throw new Error("API URL and key are required");
const { examples } = await fetch(new URL("/v1/examples", origin)).then(r => r.json());
const example = examples.find(item => item.name === "evm-transfer");
const response = await fetch(new URL("/v1/check", origin), {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify(example.body),
  signal: AbortSignal.timeout(15_000),
  redirect: "error"
});
if (!response.ok) throw new Error(`Policy API returned HTTP ${response.status}`);
const result = await response.json();
console.log(result.decision, result.reasons);
```

For Solana, select `allowed-vendor-payment` instead. Replace synthetic inputs with
your own serialized transaction and explicit policy for application use. Amounts
use base-unit decimal strings. Solana lookup tables must be supplied unless the
operator enables RPC resolution. Decoding coverage is limited to supported instructions;
an `ALLOW` result is not execution simulation or a guarantee of a safe transaction.

## Errors and limits

- `400`: malformed input. Correct the request before retrying.
- `401`: missing or invalid authorization. Provision or rotate the key.
- `413`: request exceeds 64 KiB, including JSON overhead.
- `429`: rate limit reached. Wait at least `Retry-After` seconds before retrying.
- `500`: unexpected evaluation failure. Preserve the request for diagnosis without
  logging credentials; do not treat the failure as approval.

Limits apply per customer across its keys. Invalid credentials use a separate IP
budget so they do not consume a valid customer's quota. Discovery has its own IP
budget. With a configured database, quota windows survive service restarts. The
intended deployment is one service instance using a persistent local SQLite volume.
Cross-host quota coordination and service-level availability guarantees are not provided.

## Operator setup

Build first with `npm ci` and `npm run build`. Configure these variables on the
policy API service:

```text
AGENTGUARD_PRODUCTION=true
REQUIRE_API_KEYS=true
AGENTGUARD_DB_PATH=/data/agentguard.sqlite
BASE_URL=https://<operator-provided-hostname>
TRUST_PROXY=<verified-number-of-proxy-hops>
```

The service refuses production startup without authentication, a non-memory database,
an HTTPS public base URL and an explicit proxy setting. Mount persistent storage at
`/data`; a path alone does not make container storage durable. Use `TRUST_PROXY=0`
only when there is no reverse proxy; verify the hosting topology before choosing it.

Configure the separate policy API service with start command
`node dist/src/sandbox/index.js`, health-check path `/healthz`, one replica and the
repository Dockerfile. Set these in the hosting service settings or supported
infrastructure tooling; new Railway services cannot opt into legacy config-as-code.
Connect the service to the reviewed GitHub release branch so future publication
updates its deployed source. Do not copy signing keys or Turnkey credentials into
this service.

Provision each customer against the running service's database:

```bash
node scripts/customers.mjs add "Customer name" --rate 120
```

The key is displayed once; deliver it privately. Issue a replacement with
`node scripts/customers.mjs key <customer-id>` and revoke the old key using
`revoke-key <key-id>`. Revoke all customer access using `revoke <customer-id>`.
No stored policy is needed here because each check supplies its policy. Customer
records, key hashes and rate windows are stored; transaction bodies are not persisted
by this service. Hosting providers may keep their own access logs.

## Release verification

With a dedicated verification customer key provided through the environment:

```bash
node scripts/verify-policy-api.mjs
```

Set `AGENTGUARD_EXPECT_COMMIT` to the release SHA to check reported version metadata.
The script checks public discovery, rejection of unauthenticated POST requests,
policy validation and all synthetic Solana/EVM example decisions. It never calls a
signing route. Version metadata is operator-reported, not remote code attestation.
Revoke the verification key after the release check.

Before publishing an address, also test key revocation, quota isolation, persistent
storage across restart, HTTPS and proxy behavior in the actual hosting environment.
Keep the legacy service's hostname separate until its consumers and migration plan
are known. Current source availability alone is not evidence of successful deployment.

For wallet enforcement, see [the signing integration reference](integration-and-operations.md).
