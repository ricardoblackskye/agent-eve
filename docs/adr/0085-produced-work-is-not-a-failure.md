# 0085 — A run that produced work is not marked as a failure

**Date:** 2026-11-17
**Status:** Accepted

## Context

A run can finish with working code, open a pull request, and still not be certified:
the Definition of Done reads the pull request's own checks, and refuses to declare
`done` while a required check has not settled. On WebFeedPOC#224 the checks went green
minutes after the run gave up, so a correct change sat behind a ticket labelled
`df:failed`.

The distinction already existed in the code and was being discarded. The Definition of
Done returns `DoneStatus = "done" | "blocked" | "refused"`, but the label vocabulary had
no word for the middle case, `TerminalStatus` allowed only `"succeeded" | "failed"`, and
the runner collapsed the verdict to the boolean `dodResult.ok` before handing it to the
finalizer. `df:blocked` was documented as the intended behaviour in
`definition-of-done.ts` ("the task stops and becomes `df:blocked` / `needs-answer`") but
nothing implemented it.

The cost is not cosmetic. `df:failed` is in the trigger's terminal set, so the guard
refuses any later trigger: the ticket cannot be retried without a human removing the
label by hand. Marking a recoverable run as failed therefore made it unrecoverable.

## Decision

Carry the Definition of Done's own verdict through to the lifecycle instead of a
boolean, and give the vocabulary the outcome it was missing:

- `df:blocked` means **produced work, awaiting certification**. The attempt is over; the
  change is not certified.
- The finalizer maps the verdict directly: `done` → `df:done`, `blocked` →
  `df:blocked`, `refused` → no terminal label (the long-standing #271 rule, which the
  code previously honoured only on the `succeeded` branch).
- `df:failed` is reserved for genuine failure — the runner's crash and error paths, which
  pass no verdict at all.
- **`df:blocked` is deliberately NOT terminal.** The trigger guard refuses a re-trigger
  only for labels in `TERMINAL_LABELS` (`df:done`, `df:failed`), so a blocked ticket can
  be re-triggered without editing labels. This is the whole mechanism; the guard needed
  no change in its own right.

## Consequences

**Easy:** a run that produced a pull request and is waiting on CI no longer reads as a
failure, and re-applying the trigger label retries it. The vocabulary now matches the one
the Definition of Done has been computing all along, so there is no translation layer to
drift.

**Harder:** "terminal" now has a precise meaning — *finished* — which is narrower than
"has a `df:*` label". Anything assuming every `df:*` label blocks a re-trigger is wrong.

**Deliberately not decided here:** whether `df:failed` should also be re-triggerable. The
guard is the only thing making a crashed run impossible to retry, which is circular — a run is
unable to be retried because the label says it failed, not because it is irrecoverable. That
changes what "terminal" means and is tracked separately as #677.

**Not superseded:** [0040](0040-df-run-failure-is-terminal.md) still holds for a genuine
failure - those paths pass no verdict and keep `df:failed`. This ADR only narrows what counts
as a failure; it does not change where the terminal lifecycle is applied or why.

**Consequential for #659:** #659 removed the false *success* — a run used to be recorded
`succeeded` whenever a pull request existed, so the record agreed with the ticket comment
and disagreed with the DoD. This ADR removes the false *failure* from the same branch.
