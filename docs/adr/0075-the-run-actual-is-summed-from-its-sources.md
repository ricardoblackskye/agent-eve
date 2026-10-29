# The run's actual is the sum of what it recorded

**Status:** Superseded by 0076
**Date:** 2026-10-29

## Context

`df_plan_estimate_accuracy` joins the plan's estimate to `df_run_summaries.cost_usd`. That column was
NULL on every run, so the view returned zero rows and the calibration report (#490) had to read the
usage ledger directly instead. Nothing was rolled up: the only writer of a run summary is the PR-diff
path, which is deployment- and PR-time only, and the gateway's `run.cost` events land in a different
subsystem from the in-process governed calls.

## Decision

A run's actual cost is the sum of what the run recorded, from the two places it records it:

- the **usage ledger**, for the in-process governed calls, with the tester excluded so the pair compares
  like with like (ADR 0074 defines the calibration actual that way);
- the run's own **`run.cost` events**, which the deployed gateway writes.

The two never overlap, because each is written by a different execution path, and that is what makes the
sum correct rather than double counting. It is a compliance rule, not a check: no test can detect a
future overlap, which is why #532 is instructed to revisit this if it starts recording sandbox usage in
the ledger.

The write is a NARROW update — `recordRunCost(runId, costUsd)`, a single-column `UPDATE` mirroring
`updateCommentReference` — so recording a cost cannot clobber a concurrent status change the way a
read-modify-write through `recordRunSummary` could.

It is BEST-EFFORT. A cost is an observation about a run, not a control over it, so every failure is
reported and logged and the run is unaffected. A run record fails closed; its bookkeeping does not.

And it is RECOMPUTE, NEVER ACCUMULATE: the value is always the whole sum, so a re-run replaces rather
than adds, and a resumed run grows its total. When neither source recorded anything the writer writes
NOTHING, leaving the run unmeasured rather than set to `0`: "free" and "not measured" are different
findings, and only one of them is ever true here.

## Consequences

- `df_plan_estimate_accuracy` can return rows, so the estimate/actual pair exists in the run history as
  well as in the ledger.
- **The summary and the calibration report are not identical by construction.** The summary adds the
  gateway's `run.cost` events, so a sandboxed run's summary is larger than the ledger-only figure the
  report computes. They agree in definition — recorded spend — and differ by what each can see. When
  #532 ingests the gateway's costs into the ledger, the summary's event term must be dropped in the same
  change, or that spend is counted twice.
- The runner records on both entry paths, including an abort: a run that died still spent money, and the
  release-then-clear ordering means the record happens before the claim is released.

Related: #453, #490, #531, #532, ADR 0069, ADR 0073, ADR 0074.
