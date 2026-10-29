# The calibration actual is recorded usage

**Status:** Accepted
**Date:** 2026-10-29

## Context

The estimator publishes an advisory band, and the epic's whole premise is that the band is checked
against what runs actually cost (#453, ADR 0069). #490 builds that check, and it turned out to have no
subject: the `df_plan_estimate_accuracy` view joins `df_run_summaries.cost_usd`, which is NULL on
every run recorded to date. Nothing rolls a run's spend into its summary, `df_run_events` carries a
cost only on the deployed gateway path, and `df_cost_reservations` has no `run_id` at all, so the
budget store cannot be attributed per run either.

What DOES exist is the usage ledger: every event carries `run_id`, `task_type` and a measured cost.
Since #492 the architect's planning call records one, so a per-run, per-stage measured actual is
already being written.

## Decision

The calibration ACTUAL is a run's recorded usage, summed from the usage ledger per run and per stage,
with the tester excluded. The report reads the ledger rather than the accuracy view, and a source
guard asserts it never starts reading the view instead.

The stage EXPECTATION is rebuilt from the counts a persisted estimate records (`target_file_count`,
`task_count`, `model`) and normalised to that estimate's stored `expectedUsd`, so the parts sum to the
band that was actually published rather than to a re-derivation of it.

The FACTOR is multiplicative — `mean(actual / estimate)` — because the estimator is a product of
multipliers, and a constant can only correct a scaling error, never a structural one. Below the
configured minimum sample size the report withholds every metric and publishes only the counts.

Populating `df_run_summaries.cost_usd` is deliberately NOT part of this decision: it is a separate
writer, tracked on its own.

## Consequences

- A stage whose spend was never recorded appears as unmeasured, never as zero. The developer path does
  not record usage in-process yet, so today's reports show an architect actual against a developer
  expectation, and say so rather than implying the developer ran free.
- Two subsystems that were meant to meet — the usage ledger and the run summary — are now explicitly
  declared not to have met. When the writer lands, the view becomes usable and the two agree.
- A report below the minimum sample size is a finding, not a failure: it exits 0 with the counts and
  no figures, so an empty window cannot be mistaken for a measured zero.
- Consuming the factor is a separate change, and that is the change that bumps
  `PLAN_ESTIMATOR_VERSION`: this one adds the seam only, so every already-persisted band stays
  comparable.

Related: #453, #486, #490, #492, ADR 0069, ADR 0073.
