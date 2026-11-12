# Policy demo narration

Use these cues with a fresh recording of the four commands in `demo/README.md`.
The checked-in 54-second video is an earlier recording, not evidence that a current
checkout has been tested. Check the output before reusing it.

| Scene | Narration cue |
|---|---|
| Introduction | These local examples show how AgentGuard decodes transactions and applies a policy. They do not sign or submit transactions. |
| Vendor payment | The vendor is allowlisted and the amount is within the configured limits. The decision is ALLOW. |
| Additional instruction | The second instruction cannot be decoded by the demo registry. The decision is NEEDS_REVIEW. |
| Unapproved destination | This transfer can be decoded, but its recipient is absent from the allowlist. |
| Amount limit | This transfer names an approved vendor but exceeds the per-transaction cap. |
| Review workflow | Run the separate quickstart to show authentication, a human decision, and a retry through the stand-in relayer. |

Use `demo/record-demo-video.sh` for paced terminal output. Keep generated reviewer
tokens and API keys out of recordings. Label simulated signatures explicitly.
Report current test results separately, including skipped tests.
