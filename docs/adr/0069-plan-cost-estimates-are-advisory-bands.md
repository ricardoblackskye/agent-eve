# 0069 — Plan cost estimates are advisory bands, not point forecasts

- **Date:** 2026-10-26
- **Status:** Accepted

## Context

Epic #453 asks the Dark Factory to state what a run will cost before a human
approves the plan. The original proposal derived cost from the Architect's
complexity rating mapped onto token counts. A research pass found that premise
weakly supported: expert and model difficulty ratings correlate only weakly with
actual token cost, run-to-run variance on identical tasks is large, and LLM
self-prediction is systematically low. Hidden-state regression methods were ruled
out because the provider API is closed.

At the same time, architect planning spend was being recorded under the
`developer` cost category (`scripts/dark-factory-runner.ts` passed
`category: "developer"` for the Architect's governed call). `COST_CATEGORIES`
did not contain `architect` at all. So planning spend was both filed under the
wrong category and charged against the developer's ceiling — a planning-heavy,
implementation-light run looked like an expensive developer run.

## Decision

Plan cost estimates are **advisory bands with a cost class**, never a single
number, and they never block a run. An estimate carries `lowUsd`, `expectedUsd`,
`highUsd`, a class of `XS`/`S`/`M`/`L`/`XL` on absolute thresholds anchored to the
monthly orchestrator cap (`XS < $0.25`, `S $0.25–$1`, `M $1–$5`, `L $5–$20`,
`XL > $20`), a confidence label, and a compact structural feature vector.

Supporting decisions taken with it:

- **Cold start is structural only.** With no estimate/actual history, the band is
  emitted with `confidence: "low"` rather than suppressed or faked.
- **One price source of truth.** The estimator calls the same `resolvePrice` the
  governor uses, so a plan estimate cannot disagree with a reservation.
- **`architect` is its own cost category.** Planning spend no longer consumes the
  developer ceiling. When `DF_COST_BUDGET_ARCHITECT_USD` is unset the architect cap
  defaults to the orchestrator cap; an invalid value still fails closed.
- **The estimate lives on `RunSummary`.** A separate store would need four provider
  implementations for v1; the feature vector is kept compact instead.
- **Recording starts in v1; calibration lands later.** Estimate/actual pairs are
  recorded from day one so a later release can compute a calibration factor.
- **The Tester role is out of scope** for v1.

## Consequences

Makes easy: separating planning cost from implementation cost; comparing an
estimate with the actual once the run finishes; changing a price in one place and
having both estimate and reservation move together.

Makes hard: re-attributing architect spend already recorded under `developer`
before this change. That history cannot be cleanly migrated, so the developer row
is overstated for past runs and the architect row starts at zero. No retroactive
migration is attempted.

Forces follow-on work: a runs-ledger surface for the estimate (deferred), a
calibration report consuming the recorded pairs (tracked), and a decision on
whether the band proves useful enough to keep or needs narrowing in practice.

Accepted cost: the first bands will be wide and low-confidence. That is the
honest posture while there is no history to calibrate against. A narrow band
derived from no data would be false precision.
