# AgentGuard Colosseum submission worksheet

Use this only after Jordan has supplied the facts marked **Jordan input**.
Do not turn placeholders into claims without evidence.

## Product

- **Name:** AgentGuard
- **One-line description:** A policy and human-review gate for autonomous
  Solana transactions.
- **What it does:** Decodes registered instructions, checks them against
  policy, automatically permits transactions within policy, and routes
  unknown or policy-violating actions to human review before signing.
- **Repository:** Confirm the public repository URL and default branch in
  the logged-in submission account before pasting it.
- **Logo:** `assets/agentguard-logo.svg`

## Solana implementation

- **Network and tools:** Solana, `@solana/web3.js`, `@sqds/multisig`,
  `@solana/kora`, TypeScript, and `solana-clear-sign`.
- **Technical proof:** Run `npm run build`, `npm test`, and the four scripts
  listed in `demo/README.md` immediately before recording or submitting.
- **Known boundary:** Unknown or unverified instructions fail closed to
  `NEEDS_REVIEW`; do not say that AgentGuard understands arbitrary
  instructions.

## Videos

- **Pitch video:** Jordan records himself using `demo/founder-pitch-script.md`.
  Replace every bracketed placeholder with facts Jordan confirms.
- **Technical demo:** Use `demo/agentguard-demo-video.mp4` as the visual cut
  and add Jordan's real narration using `demo/demo-video-script.md`.
- **Final check:** Confirm each video duration against the live portal's
  stated limit, because portal requirements override this worksheet.

## Jordan input required before submission

- Full team member names, roles, short backgrounds, and locations.
- A truthful go-to-market plan: first user segment, how the team will reach
  it, and what a successful first pilot means.
- Any real user conversations, feedback, pilots, or community ties. If there
  are none, say so plainly and use the next-validation plan in the pitch.
- Founder contact details and confirmation that the project is submitted on
  behalf of the correct company or individual.
- A final check that the repository is accessible to reviewers.

## Final release gate

- [ ] Public or reviewer-accessible repository verified from the final link.
- [ ] Default branch contains the intended submission code.
- [ ] Build, lint, and tests pass on that branch.
- [ ] Product description contains no unsupported competitive, security, or
      adoption claims.
- [ ] Pitch video recorded by Jordan and checked against the factual script.
- [ ] Demo narration recorded by Jordan and checked against the real demo.
- [ ] Team, location, contact, and go-to-market details supplied by Jordan.
- [ ] Every live portal field reviewed before final submission.
