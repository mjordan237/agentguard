# Demo scenarios

Four runs, all real (no mocked decode/policy calls) -- built and confirmed
working:

```
npm run build
node dist/demo/legitimate-payment.js
node dist/demo/adversarial-payment.js
node dist/demo/unapproved-destination-payment.js
node dist/demo/over-limit-payment.js
```

## Run 1: `legitimate-payment.ts`

The property-maintenance agent pays a vendor for completed work: one
`SystemProgram.transfer` instruction. Decodes cleanly to
`{lamports, from, to}`, program is on the policy's allowlist.

**Result: `ALLOW`.**

## Run 2: `adversarial-payment.ts`

Same vendor payment, but a second instruction has been appended --
`SystemProgram.assign`, reassigning the agent wallet's own account to an
attacker-controlled program. This is the same threat class as SPL
Token's `SetAuthority` hijack described in the July 2026 USENIX-accepted
x402 security paper: it moves zero balance, so a simulator that only
diffs balances would call this transaction safe.

The IDL registry only has `transfer` registered for System Program (see
`demo/policy.ts`) -- deliberately, to keep the registry itself honest
about what's actually been verified. `Assign`'s discriminator (`[1,0,0,0]`)
matches nothing in it, so it can't be named or decoded, and the
instruction falls to `raw_dump`.

**Result: `NEEDS_REVIEW`**, with the hidden instruction shown right next
to the legitimate-looking payment, in original transaction order -- not
a silent `ALLOW`.

## Confirmed actual output (not illustrative)

```
=== Adversarial: vendor payment + injected authority hijack ===
Decoded intent:
  111111...111 :: transfer (interpolated)
    {"lamports":"250000000","from":"...","to":"..."}
  111111...111 :: unknown (raw_dump)
    {"reason":"No instruction in the registered IDL matches this data's discriminator."}

Decision: NEEDS_REVIEW
Reasons: Instruction on 111111...111 could not be verified and fell back to raw_dump.
```

## Run 3: `unapproved-destination-payment.ts`

A transaction that decodes perfectly cleanly -- no hidden instruction,
nothing a discriminator check would flag. It's just a payment to a
destination that was never approved as a vendor (e.g. an agent tricked
by a prompt injection into paying the wrong address). This is the case
run 2 does *not* cover.

**Result: `NEEDS_REVIEW`**, reason: `Destination ... is not in the allowlist.`

## Run 4: `over-limit-payment.ts`

An approved vendor, a cleanly-decoded transfer, but the amount is well
over the per-transaction cap (3 SOL against a 1 SOL limit).

**Result: `NEEDS_REVIEW`**, reason: `Amount ... exceeds the per-transaction limit ...`

## For the pitch video

Two "aha" moments, not one: show runs 1 + 2 side by side for the hidden-
instruction catch, then runs 3 + 4 to show that even a transaction with
*nothing* structurally wrong with it -- fully legible, fully verified,
correctly named -- still gets stopped when it violates policy. That's
the difference between "can we decode this" and "should this be
allowed," and this project does both.
