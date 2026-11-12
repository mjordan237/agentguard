# Local demo scenarios

## Run the policy examples

Build the project, then run each scenario:

```sh
npm ci
npm run build
node dist/demo/legitimate-payment.js
node dist/demo/adversarial-payment.js
node dist/demo/unapproved-destination-payment.js
node dist/demo/over-limit-payment.js
```

Check the printed decision and reasons against this table:

| Scenario | Expected decision | What to inspect |
|---|---|---|
| Legitimate vendor payment | `ALLOW` | One transfer to the allowlisted vendor within the amount limits. |
| Payment with an account-assignment instruction | `NEEDS_REVIEW` | The second instruction is not decoded by the demo registry. |
| Unapproved destination | `NEEDS_REVIEW` | The recipient is absent from the destination allowlist. |
| Over-limit payment | `NEEDS_REVIEW` | The transfer exceeds the per-transaction cap. |

Use `demo/policy.ts` to inspect the demo registry and limits. These four scripts
perform local decoding and evaluation. Do not present their output as a signature,
a submitted transaction or a persisted human-review record.

## Run the review workflow

```sh
npm run quickstart
```

Open the printed review URL and sign in with the generated demo reviewer token.
Inspect the held transaction, approve or deny it, and observe the retry outcome.
The demo relayer returns a stand-in signature. Do not treat it as an on-chain result.
For the automated local smoke test, run:

```sh
PORT=0 npm run quickstart -- --auto-approve --exit
```

## Rehearse the advisory AI note

```sh
node dist/demo/nemotron-review-demo.js --stub
```

Use the stub for a local rehearsal. The note is labelled `local-stub-not-nemotron`.
For the external model configuration, see [optional reviewer explanations](../docs/integration-and-operations.md#optional-reviewer-explanations) and provide
credentials through the documented environment variables. Keep credentials out of recordings.

## Inspect the implementation

See [the technical walkthrough](technical-walkthrough-script.md) for the relevant
source files and test coverage. The demo policies and generated wallets are sample
data, not deployment configuration.
