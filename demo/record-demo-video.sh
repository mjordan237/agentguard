#!/usr/bin/env bash
# Paced recording of four local policy-evaluation scenarios.
# Start screen recording before running this script.
# These commands evaluate transactions; they do not sign or submit them.
set -euo pipefail
cd "$(dirname "$0")/.."

CUE_PAUSE="${CUE_PAUSE:-5}"     # seconds to read a cue before the command runs
RESULT_PAUSE="${RESULT_PAUSE:-4}" # seconds to let the result sit on screen

bold=$'\033[1m'
dim=$'\033[2m'
reset=$'\033[0m'
green=$'\033[32m'

cue() {
  echo
  echo "${bold}${green}>> SAY:${reset} ${bold}$1${reset}"
  echo "${dim}(recording resumes in ${CUE_PAUSE}s -- read this, then let the command run)${reset}"
  sleep "$CUE_PAUSE"
}

pause_on_result() {
  sleep "$RESULT_PAUSE"
}

clear
echo "${bold}Building the project (silent, so the recording starts clean)...${reset}"
npm run build >/dev/null

clear
cue "These four local scenarios show transaction decoding and policy evaluation. They do not sign or submit transactions."
sleep 1

clear
cue "First, a transfer to an approved vendor within the policy's amount limit. Check that the decision is ALLOW."
node dist/demo/legitimate-payment.js
pause_on_result

clear
cue "The next transaction adds an account-assignment instruction. Check that the undecoded instruction produces NEEDS_REVIEW."
node dist/demo/adversarial-payment.js
pause_on_result

clear
cue "The demo registry does not decode that second instruction. The policy holds the transaction for review."
sleep 1

clear
cue "The next transfer can be decoded, but its destination is absent from the allowlist. Check the destination reason."
node dist/demo/unapproved-destination-payment.js
pause_on_result

clear
cue "This transfer names an approved vendor but exceeds the per-transaction amount limit."
node dist/demo/over-limit-payment.js
pause_on_result

clear
cue "The three held scenarios return NEEDS_REVIEW. Run the separate quickstart to demonstrate the authenticated review and signing flow with a stand-in relayer."
sleep 1

echo
echo "${bold}Done. Stop the recording.${reset}"
