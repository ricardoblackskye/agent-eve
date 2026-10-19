# 0051 — Retiring a stale claim abandons the run, and leaves a record

- **Status:** Accepted
- **Date:** 2026-10-19
- **Issue:** #404 (R2)

## Context

A run that stops without finishing keeps holding its issue's claim, because ADR 0026 makes the claim atomic: one
active run per repo+issue, with `queued`/`running`/`blocked` all counting as active. R1's end-to-end acceptance
ended on exactly that:

> `the ledger already holds an active run (38e52448-…, status 'blocked') for ricardoblackskye/webfeedpoc#169, so
> this attempt was not recorded. This run will not start: wait for that run to finish, or retire its claim if the
> process is gone.`

Both options were real; only one was possible. Nothing in the repository could retire a claim, so the only way to
run again was to destroy the ledger.

The obvious implementation — release the claim — is wrong, and this record exists because of why. A parked run is
legitimately *active*: it resumes when a human answers (ADR 0041/0022). Releasing its claim without ending it would
let the parked run resume later and leave **two agents on one issue**, the exact outcome the claim exists to
prevent.

## Decision

**Retirement is a terminal transition, not a released lock.**

1. **It is a named, recorded operation.** `retireRunClaim` marks the run terminal (with `completed_at`, through the
   existing record layer's rules) and *then* the claim is released, because a terminal run is no longer active.
   Nothing is deleted: the ledger still explains how the run stopped.
2. **A LIVE (`running`) holder is REFUSED.** Work in flight is never cut out from under itself. The holder is
   re-read inside the transaction (sqlite) / selected `FOR UPDATE` (Postgres), so the guard cannot be raced.
3. **A parked (`blocked`) holder MAY be retired.** A park is a WAIT, not work — and the retirement is precisely what
   makes it unable to resume, which is what keeps decision 1 safe.
4. **No new run status.** The run keeps its own vocabulary (`aborted`, stage `terminal`) and the cause is carried by
   the self-describing terminal event id `retire-claim:<runId>`, exactly as the #328 duplicate repair names its own
   terminations. The ledger never grows a second truth about one run.
5. **The label is reconciled by the same operation**, reusing the finalizer's own `CLEARED_LABELS` set, so a retired
   run leaves the same label state as any other terminal transition. Retirement applies **no** terminal label: it is
   neither a success nor a failure.
6. **A refusal changes NOTHING.** A live holder, or no claim at all, returns without a single label write.
7. **Free-form operator text stays out of the ledger** (as `operator-actions.ts` already decides): the reason is
   printed to the operator and returned in the report, and the ledger records the machine-readable fact.
8. **A partial outcome is reported as one.** If the ledger retires but a label write fails, the ledger is *not*
   rolled back (the retirement is real), and the result is `retired-unreconciled` with a distinct exit code, because
   a ticket still advertising `df:running` is the symptom this release removes.

## Consequences

- The refusal that prompted this release is now actionable: the launcher prints the holder *and* the command.
- **Retiring a run is not the same as aborting a live one.** Retention is for a process that is gone; the control
  plane's `abort` remains the way to end work that is still running. Two operations, because they answer two
  different questions — and the refusal message must not blur them.
- An operator who retires a run a human was about to answer loses that park. That is deliberate: the operator
  asserts the process is gone, and the alternative is a claim nothing can release.
- Automatic expiry by age was rejected. A clock cannot know whether a park is abandoned or awaiting an answer, and
  a heuristic that retires a live park would create the two-agents outcome by policy.
