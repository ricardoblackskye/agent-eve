# 0073 — Plan estimates live in the plan ledger, not on the run summary

- **Date:** 2026-10-28
- **Status:** Accepted

## Context

[ADR 0069](0069-plan-cost-estimates-are-advisory-bands.md) decided that a plan estimate would live on `RunSummary`,
on the reasoning that a separate store would need four provider implementations for v1. **That is not what was
built.** [#486](https://github.com/ricardoblackskye/agent-eve/issues/486) persisted the estimate in the plan ledger instead:

- tables `df_plans` and `df_plan_estimates`, the latter keyed by `plan_id` and carrying `run_id`, `estimator_version`,
  `low_usd`, `expected_usd`, `high_usd`, `cost_class`, `confidence`, `revision_factor`, `history_samples`,
  `target_file_count` and `task_count`, with a `(period, cost_class)` rollup index and a `run_id` index;
- two implementations rather than four (Postgres and SQLite), so the premise that decided 0069's storage choice no
  longer holds;
- and no estimate field on `RunSummary` at all, under any name.

The ledger is the natural home for a different reason than cost: an estimate prices a **plan revision**, and the
ledger is write-once per `(run_id, plan_revision)` — the estimate follows the plan it priced, not the run it happened
to occur in. `RunSummary` carries the run's **actual** cost (`cost_usd`), which is the other half of the pair.

The ledger also exposes an accuracy seam: `listEstimateAccuracy(period?)` reads the
`df_plan_estimate_accuracy` view, which joins the estimate to the run summary and computes
`signed_error_usd`. It returns **zero rows today**, because nothing writes a run-level actual — see Consequences.

## Decision

Plan estimates are persisted in the **plan ledger**, keyed by `run_id` and stamped with `estimator_version` so a
later recalibration can never average bands from a different constant set. `RunSummary` is not the home for an
estimate.

This record **supersedes 0069 in full**, and re-affirms the decisions within it that still hold:

1. Estimates are **advisory bands**, never point forecasts, and never block a run.
2. Cost classes are absolute thresholds anchored to the monthly orchestrator cap.
3. The estimator uses **one price source of truth** — the same `resolvePrice` the governor uses.
4. `architect` is its own cost category, defaulting to the orchestrator cap when its env var is unset, and failing
   closed when it is invalid.
5. Recording starts in v1; calibration lands later, from the recorded pairs.
6. The Tester role is out of scope for v1.
7. Cold start is structural only: with no history the band is emitted as low confidence, never suppressed or faked.

## Consequences

Makes easy: per-run and per-class aggregates through the existing `(period, cost_class)` index; a recalibration that
cannot mix estimator generations; and the accuracy join, because the estimate and the actual now sit on their
respective sides of it deliberately.

Makes hard: recovering the intent, because the ADR and the code disagreed from #486 until an audit found it. The
lesson is procedural, not technical — a decision recorded at plan time must be checked against what shipped before
the change is closed, or the record becomes a plausible account of a system that does not exist.

Forces follow-on work: the accuracy view needs a **run-level actual written from the settled calls** before it can
report a single row, and the by-stage split needs architect usage events. The first is the calibration report's blocker, [#490](https://github.com/ricardoblackskye/agent-eve/issues/490); the second is [#492](https://github.com/ricardoblackskye/agent-eve/issues/492). Both are tracked on the epic
[#453](https://github.com/ricardoblackskye/agent-eve/issues/453), alongside the calibration report that consumes the
result.

This is the set's **first supersession**, so the chain rules in the index are now exercised rather than documented
only: 0069 points here, and this record points back at 0069.
