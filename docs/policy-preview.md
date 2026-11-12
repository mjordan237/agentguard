# Policy preview tools

[Back to the project overview](../README.md). Run commands from the repository root.

## Preview server

`npm run sandbox` starts a separate preview server (port 8788 by default) where anyone can check a
transaction against a policy they send. It cannot sign, holds no keys, does not store requests, does not
rehearse swaps or track spending across requests (daily limits use the `spentToday` the request supplies), opens no reviews and has
none of the gate's routes; it runs the same engine as `npm run check`. `GET /` is a docs page with a playground,
`GET /openapi.json` describes the API, and `GET /v1/examples` returns request bodies to try, each with the
decision it should get.

Start the server and retrieve complete example request bodies:

```bash
npm run sandbox
# In another terminal:
curl --fail http://localhost:8788/v1/examples
```

Use the local playground at `http://localhost:8788/` to submit an example.
The preview server is separate from the authenticated signing service. It does not
provide customer API-key authentication; add and validate access controls before
exposing it publicly. These instructions do not identify a deployed public API.


**Verifying a result.** Every response carries `receipt.inputHash` (SHA-256 of the input as understood:
the parsed policy, the transaction, what was spent, and the lookup tables used) and `receipt.resultHash`
(SHA-256 of the decision, reasons, decoded instructions and spend), both over JSON with sorted keys. Check out
the commit `GET /v1` reports as `sourceCommit`, run `npm run check -- --json` on the same input (pass
`--lookup-tables` with the `lookupTables` the response returned), and compare the receipts. `sourceCommit` is deployment metadata, not an attestation of the running code. Key order
and whitespace in a request do not change it.

Settings: `PORT`, `SANDBOX_REQUESTS_PER_MINUTE` (default 60 per client), `TRUST_PROXY`, `SOURCE_COMMIT`
(Railway's `RAILWAY_GIT_COMMIT_SHA` is used if set), `SANDBOX_REPOSITORY_URL` (shown on the docs page; defaults to the public GitHub repository) and, optionally, `SANDBOX_RPC_URL` to read lookup tables a
request does not include. Bodies are capped at 64 KB and at most 8 lookup tables of 256 addresses each are
accepted. The container image runs it with `node dist/src/sandbox/index.js`.

## Offline policy checks

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
For the EVM request fields see the [EVM reference](integration-and-operations.md#evm-ethereum-gate).

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

Replace the example destination with a valid vendor address. Amounts are whole numbers in the smallest unit (lamports for SOL), written as strings. Configure explicit limits for each value-moving asset.
