# Animated demo narration reference

Use this scene list to plan a new recording. The checked-in animation was captured
from an earlier build. Compare its screens with the current authenticated workflow
before reusing it. Its relayer signature is simulated; the Ethereum example uses
illustrative addresses.

| Time in the existing clip | Scene | Narration cue |
|---|---|---|
| 0:00 | Title | AgentGuard checks a proposed transaction against a policy before a signer is called. |
| 0:06 | Additional instruction | Inspect every instruction, including operations that do not transfer a balance. |
| 0:19 | Policy evaluation | Compare decoded instructions with the configured program, destination and amount rules. |
| 0:29 | Vendor payment | This example is within the policy and uses a stand-in relayer. |
| 0:39 | Undecoded instruction | The transaction is held for review because the second instruction is not decoded. |
| 0:53 | Destination and amount | One example uses an unapproved destination; another exceeds the per-transaction cap. |
| 1:05 | Human review | In a new recording, show sign-in before displaying review details, then a decision and retry. |
| 1:24 | EVM approval | Distinguish an allowance from a payment. Label an unlimited allowance explicitly. |
| 1:40 | Validation status | State the current verified results and outstanding integration checks. Do not infer customers, deployment or production readiness from this clip. |

Before publishing a recording, verify the displayed contact details, replace stale
screens, and remove visible credentials. Use the current test output for any test
count. Do not copy historical release or adoption claims into a new narration.
