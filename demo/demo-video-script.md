# Demo Video: Narration Script

This is the narration for `agentguard-demo-video.mp4`, the video already
sent to you. It's silent, 54 seconds, and built from the real output of
running AgentGuard's four demo scenarios. Colosseum's cap is 3 minutes,
so there's room to breathe.

## How to add narration

Record yourself saying the lines below in your own words rather than
reading them exactly, then lay that audio under the existing video in
whatever editor is easiest for you (QuickTime, iMovie, CapCut all
work). The video already has pauses timed in at each beat, so you don't
need to re-cut anything, just talk over each section as it plays.

If you'd rather record a completely fresh version yourself instead of
narrating over this one, there's a script for that too:
`./demo/record-demo-video.sh` paces the real commands live in your
terminal so you can screen record and narrate in a single take. That's
entirely optional. The video you already have doesn't need it.

## Narration beats

1. **Intro.** AgentGuard sits between an agent and its wallet. Before
   anything signs, it decodes registered instructions, checks them
   against policy, and routes unknown or policy-violating actions to a
   human.
2. **Legitimate payment.** A normal vendor payment. One transfer,
   decodes cleanly, matches policy, goes through.
3. **Adversarial payment.** Same payment, but a second instruction has
   been quietly appended that reassigns the agent's own account to an
   attacker-controlled program. It moves zero balance, so anything that
   only checks balances would miss it completely.
4. **Why it's caught.** That second instruction isn't in AgentGuard's
   registry, so it refuses to guess what it does and flags the whole
   transaction for a human instead of letting it through or blocking it
   blindly.
5. **Unapproved destination.** This one decodes perfectly cleanly,
   nothing hidden, it's just paying an address that was never approved.
   The kind of mistake a prompt-injected agent could make without any
   single instruction looking wrong.
6. **Over the limit.** Same idea, different rule. A real, approved
   vendor, but the amount is over the daily limit.
7. **Close.** Every one of those gets turned into a real review task for
   a human instead of a silent guess or a black-box block. That's
   AgentGuard.
