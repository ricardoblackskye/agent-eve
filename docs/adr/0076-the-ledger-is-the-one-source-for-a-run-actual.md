# The ledger is the one source for a run's actual

**Status:** Accepted
**Date:** 2026-10-29

## Context

ADR 0075 summed a run's actual from two sources — the usage ledger and the run's own `run.cost` events —
on the grounds that each is written by a different execution path and they therefore never overlap. It
held the double-counting risk open as a compliance rule and named this issue as where it had to be
revisited if the gateway's spend ever reached the ledger.

It now does. The sandbox's model calls are the developer's spend, and the gateway forwards them through
the same governed seam the in-process loop uses — the same seam that settles from the provider's usage.
So the measured tokens are already in hand at the settle point; they simply never left it, because what
the gateway reported onward was a reservation estimate with no tokens and no task type. That is why the
usage ledger had never seen a developer row, and why the calibration report showed that stage as
unmeasured.

Two alternatives were considered and rejected. Wiring the `WorkerUsageSink` that `DeveloperAgent` already
exposes cannot work: the agent calls `record()` with no measurement, and the sandbox reports no tokens,
so it would write an empty event — worse than writing nothing, because it would look like a measurement.
Ingesting the existing `run.cost` events carries no tokens and only a money estimate, which would record
an estimate as an actual.

## Decision

The gateway measures the call it just paid for, from the upstream response, and records it in the usage
ledger as an event typed **`developer`** — the name the estimator's split uses, so a by-stage comparison
lines up rather than inventing a third stage.

The measurement is taken once, by a pure helper, and used for BOTH the settle (`costOf`) and the ledger,
so the settled cost and the recorded cost cannot disagree. It prices through the governor's own resolver:
one price source. Cost needs both token counts, and an unpriced model keeps its tokens while reporting no
cost, because an unpriced call is not a free one.

**The usage ledger is the one source for a run's actual.** The run summary reads it alone. This writer
REPLACES the summary's cost rather than adding to it, which also supersedes the run history's #281
behaviour of folding a cost event onto its run: the event remains as the call's trail, and the measured
total is what the row carries.

A stage with an expectation but no recorded actual is marked unmeasured and carries no bias, MAE or MAPE.
It still appears in the by-stage breakdown, so a blind spot stays visible instead of vanishing.

## Consequences

- The calibration report's developer stage carries a real figure where the gateway forwarded a
  measurable call, and says `measured: false` where it did not.
- A deployment without the usage driver records nothing, and the report says so rather than guessing —
  the same opt-in posture as every other usage seam.
- `df_plan_estimate_accuracy`'s actual, the run summary's cost, and the calibration report's bias all
  derive from the ledger now, so they cannot drift apart by source.
- The estimate is never recorded as an actual: an unmeasured run stays unmeasured.

Related: #453, #490, #531, #532, ADR 0069, ADR 0074, ADR 0075 (superseded).
