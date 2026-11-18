# 0090 — An unfinished check is not a failure

- **Status:** Accepted
- **Date:** 2026-11-18
- **Issue:** #691

## Context

The Definition of Done was asked to judge a pull request whose end-to-end suite had not finished. It
wrote two findings that differ only in their id:

```
PR-CHECK-UNSETTLED:e2e          the check has not finished (in_progress)
PR-CHECK-FAILED:MegaLinter      the repository's own check failed
```

Both were `severity: "error"`, and nothing downstream read either id: a search of the agents, the
runner and the tests found only the producer and a comment. The verdict vocabulary is `done`,
`blocked` or `refused`, so an `e2e` suite still running when the wait reached its bound (ADR 0087)
and a check that had run and said no arrived at the ticket as the same outcome. The running one may
yet pass.

Refusing to certify was correct (ADR 0087, #659 Stage 3): a run must not claim done against an
outcome it cannot see. What was missing was a way to say **why** it did not certify.

## Decision

The blocked outcome carries a machine-readable reason — `blockedReason: "checks-not-finished"`, with
`pendingChecks` naming them. The status vocabulary is unchanged (`blocked` already means "not done,
and resumable"; #672 / ADR 0085), and the certification refusal is untouched: the run is still not
done, it simply says which kind of not done it is.

The reason is set only when an unfinished check is the **whole** of the obstacle, and it is
fail-closed in both directions:

- any other unresolved finding withholds it, because the run is then not merely waiting; and
- a failed check is never reported as a wait, because that would launder a failure into a delay.

The deferral is a **re-entry, not a longer wait**. There is no queue, worker or scheduler (that work
is parked in #668) and the deployed path runs the loop inline inside a request, so a longer timeout
is not available. The ticket therefore stays re-triggerable, and the outcome comment documents the
re-trigger rather than implying a scheduler: remove and re-apply the `dark-factory` label once the
checks settle.

## Consequences

- An operator — and anything that re-triggers a run — reads a field instead of parsing prose, and the
  ticket says "wait" rather than "no".
- A check that genuinely failed is still a failure, and remains terminal.
- Re-triggering is manual until #668 provides an executor that could schedule it. That is a
  scheduling decision, not this one.
- A check that is red for reasons the change did not cause (a repository-wide advisory) is
  deliberately out of scope: feeding it back into the developer loop would spend the loop's budget on
  something the agent cannot fix.
