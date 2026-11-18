# 0086 — A failed attempt is retryable

**Date:** 2026-11-17
**Status:** Accepted

## Context

A ticket carrying `df:failed` could not be re-triggered. The trigger's guard refused a
re-trigger for every label in `TERMINAL_LABELS`, and `df:failed` was one of them, so a
crashed run could only be retried by a human removing the label by hand.

That made the word do two jobs at once. #672 established the rule *do not mark a run
failed unless it is genuinely impossible to retry* — but the guard was what made it
impossible. Whether `df:failed` is an accurate description of the outcome and whether the
ticket may be started again are different questions, and one label was answering both.
Both #228 and #230 are the recorded symptom: runs that produced pull requests and could
not be retried.

Nothing else blocked a retry. The run's start already clears `OUTCOME_LABELS`
(`df:done`, `df:blocked`, `df:failed`) — the #373 behaviour — so a fresh attempt removes
the stale label before marking the ticket in flight. The guard was the only obstacle.

## Decision

`df:done` alone makes a ticket un-triggerable, and the guard refuses a re-trigger for
nothing else. A re-trigger on `df:failed` is a deliberate retry: a new attempt on the same
ticket, which clears the previous attempt's outcome label on the way in.

- **Terminal** describes the ATTEMPT — it finished. `df:failed` and `df:done` are both
  terminal.
- **Un-triggerable** describes the TICKET — it must not be started again. Only `df:done`
  is.

Three label sets, and they are meant to stay distinct: `TERMINAL_LABELS` (`done`,
`failed`) describes a finished attempt; `OUTCOME_LABELS` (`done`, `blocked`, `failed`)
is what a fresh start clears; `RETRIGGER_REFUSED_LABELS` (`done`) is what the guard
refuses. Collapsing any two of them re-creates a defect already found.

The active-run claim (ADR 0026) remains the guard against a second concurrent run. A
ticket mid-run carries `df:running` rather than an outcome label, so the trigger guard is
not what protects it — the claim is.

## Consequences

**Easy:** a crashed run is retried by re-applying the `dark-factory` label, which is what
an operator reaches for. The retry is visible in the ledger because a fresh dispatch mints
a new run id, so attempts accumulate as rows rather than being overwritten.

**Harder:** "terminal" and "un-triggerable" must not be used interchangeably in the
factory's own prose. A reader who assumes every terminal label is un-triggerable will
misread `df:failed`.

**Deliberately decided here, and it is a judgement:** `df:done` is not re-triggerable. Work
that landed should not silently be redone by a label event; redoing it belongs to a fresh
ticket, which also keeps the two attempts' histories separate. If that ever needs to change,
it is another ADR rather than a quiet widening of the refused set.

**Not superseded:** 0085. This ADR decides what 0085 explicitly deferred — its Consequences
record that the question "changes what 'terminal' means and is tracked separately as #677" —
so 0085's decision about `df:blocked` stands unchanged alongside it.
