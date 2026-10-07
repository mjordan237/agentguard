#!/usr/bin/env bash
# Paced walkthrough for recording the Colosseum demo video (<=3 min).
# Run this, hit screen-record first, then just read each cue aloud in
# your own words while the real output plays -- nothing here is staged,
# every command below runs the actual built demo scripts.
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
cue "AgentGuard sits between an agent and its wallet. Before anything signs, it decodes registered instructions, checks them against policy, and routes unknown or policy-violating actions to human review."
sleep 1

clear
cue "First: a normal vendor payment. One transfer, decodes cleanly, matches policy -- this should just go through."
node dist/demo/legitimate-payment.js
pause_on_result

clear
cue "Same payment, but a second instruction has been quietly appended -- it reassigns the agent's own account to an attacker-controlled program. It moves zero balance, so anything that only checks balances would miss this completely."
node dist/demo/adversarial-payment.js
pause_on_result

clear
cue "That second instruction isn't in AgentGuard's registry, so it refuses to guess what it does -- and flags the whole transaction for a human, instead of either blocking blindly or letting it through."
sleep 1

clear
cue "This next one decodes perfectly clean -- nothing hidden. It's just paying an address that was never approved. The kind of mistake a prompt-injected agent could make without any instruction looking wrong."
node dist/demo/unapproved-destination-payment.js
pause_on_result

clear
cue "Same idea, different rule -- a real approved vendor, but the amount is over the daily limit."
node dist/demo/over-limit-payment.js
pause_on_result

clear
cue "Every one of those blocked transactions becomes a real review task for a human -- not a black box, not a silent guess. That's AgentGuard."
sleep 1

echo
echo "${bold}Done. Stop the recording.${reset}"
