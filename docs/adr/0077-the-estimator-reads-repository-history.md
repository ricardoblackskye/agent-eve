# The estimator reads the repository's finished runs

**Status:** Accepted
**Date:** 2026-10-29

## Context

The plan estimate was computed with no history at all, which made two of its inputs read as if they were
measured when neither was: `confidenceFor([])` is always `"low"` and `revisionFactorFor([])` is always `1`,
so every persisted estimate carried `history_samples: 0` and the band was always the cold-start band.

The signals were already recorded. `revisionFactorFor` sums exactly `RunSummary.iterationCount` and
`fixCycleCount`, both required on every run, and the store can produce the runs — `listRuns` filters by
`repo` and `statuses`. The estimator is pure by design, so the window has to be selected by a caller that
already holds a store and handed in as `history`.

## Decision

The window is **the repository's finished runs, newest first, capped at 20**.

- **Finished means `succeeded`, `failed` or `aborted`.** A `blocked` run is a park: its counters describe
  an incomplete outcome, and a parked plan says nothing about how much revision the work needed. `queued`
  and `running` have not run at all.
- **Failures are included.** A failed run's revision counts are precisely the thrash this factor exists to
  capture, and including them can only raise the band. Understating cost is the failure that matters.
- **A malformed row is dropped, never clamped.** One row carrying `NaN` or a negative count would make the
  whole band `NaN`, which is worse than a cold start, because a `NaN` band is not merely wrong but
  unusable.
- **The read is best-effort.** A failure warns and yields an empty window — the cold start the estimator
  already handles — so a plan never fails over its calibration history.
- **The estimator's stamp moves to `v2`.** No constant changed, but the band does for the same input, and
  the stamp is what keeps two different behaviours from being averaged together in a later calibration.

Dispersion-aware confidence is deliberately NOT part of this. The module's own note defers it to the
estimate/actual pairs #490 builds, which now exist end to end — but it needs a second input on a module
kept pure on purpose, and it changes what the label MEANS. That is a separate decision, tracked on its own.

## Consequences

- The band rises for repositories with history, which is the intent. A plan's cost class can therefore move
  for the same story, and the `v2` stamp is what keeps that regime distinguishable in the ledger.
- `confidence` now counts something: `medium` from one sample, `high` from ten. It still measures how much
  history there is, not how well estimates have matched what runs actually cost — the coarse label the code describes.
- The window is per repository, not per kind of work. A repository mixing very different work sizes feeds
  one factor, which is coarser than the data allows; the calibration report can inform a finer window later
  rather than this guessing at one now.

Related: #453, #486, #490, #533, ADR 0069, ADR 0074.
