# AgentGuard technical walkthrough

Use a local checkout and generated demo data. Keep real credentials and customer
transactions out of recordings. Do not run the mainnet test scripts for this walkthrough.

## 1. Build and test

```sh
npm ci
npm run build
npm run lint
npm test
```

Report the totals printed by this run. Identify skipped tests and their required
configuration. Do not describe fake-service tests as validation against a live provider.

## 2. Inspect decoding and policy evaluation

Open `demo/policy.ts`, `src/agent-integration/parse-transaction.ts` and
`src/policy/evaluate.ts`. Trace the registry lookup, decoded instructions,
destination checks, and per-transaction and daily limits.

Run the four commands in `demo/README.md`. Show the decision and reasons for each:

1. Transfer to an allowlisted vendor within the limits.
2. The same payment with an undecoded account-assignment instruction.
3. Transfer to an unapproved destination.
4. Transfer exceeding the per-transaction cap.

Do not describe these evaluation-only commands as signing or submitting transactions.

## 3. Demonstrate authenticated human review

```sh
npm run quickstart
```

Open the printed review link. Show the sign-in shell before authenticating. Sign in
with the demo reviewer token, inspect the instructions and reasons, and approve or
deny the review. Show the action's explicit applied or already-decided result.
Observe the agent's retry and identify the relayer signature as a stand-in.

Inspect `src/escalation/review-routes.ts`, `src/escalation/pending-store.ts` and
`test/review-resolution.test.ts` for authorization and atomic decision attribution.
Show customer scoping and the reviewed policy fingerprint. Keep reviewer tokens out
of the recording and avoid displaying terminal output containing credentials.

## 4. Inspect signing and recovery boundaries

Trace `/gate-and-sign` in `src/api/server.ts` and the Kora fee-payer checks in
`src/gateway/kora-gate.ts`. Use `test/kora-gate.test.ts` and
`test/review-approval-signing.test.ts` to examine fake-relayer behavior and the
single-use approval checks. Distinguish those tests from real network validation.

For Turnkey, inspect `src/turnkey/approver.ts` and `src/turnkey/lifecycle-store.ts`.
Keep the original signing activity separate from AgentGuard's vote activity.
Show pending-vote reconciliation, persisted retry state, and retained accounting
for uncertain external outcomes. Review `test/turnkey.test.ts` for failure cases.

Do not claim production readiness from this walkthrough. Resolve any outstanding
authorization findings before publishing the branch or enabling signing.

## 5. Inspect observability and limitations

Use the authenticated operator queue and review detail to distinguish policy
assessment, reviewer decision, approval consumption, and signing or vote outcome.
Inspect the customer-scoped audit API and `src/observability/audit-log.ts`.

Close with the [documented limitations](../docs/integration-and-operations.md#known-limitations): bearer-token reviewer access, local
SQLite storage, dependency advisories, and the integration checks still outstanding.
For Squads, distinguish a proposed buffer's bytecode fingerprint from source verification.
Do not claim that a service is deployed without checking its current deployment.
