/**
 * Dark Factory — the history a plan estimate is calibrated against (#533, epic #453).
 *
 * The estimator is PURE: it cannot read a store, so the window is selected here by a caller that already
 * holds one and handed in as `history`. See ADR 0077.
 *
 * What a run has to be to count:
 *
 * - **FINISHED.** `queued` and `running` have not run; `blocked` is a PARK, so its counters describe an
 *   incomplete outcome. Only `succeeded`, `failed` and `aborted` describe work that actually played out.
 * - **USABLE.** `revisionFactorFor` sums `iterationCount` and `fixCycleCount`, so a row whose counters are
 *   not finite and non-negative is dropped rather than averaged: one malformed row would make the whole
 *   band `NaN`, which is worse than a cold start.
 * - **NEWEST FIRST, CAPPED.** The window is a look back, so the most recent work wins.
 *
 * Properties this module must keep:
 *
 * - **PURE.** No store, no clock, no environment, no randomness.
 * - **FAILURES ARE INCLUDED.** A failed run's revision counts are exactly the thrash the factor captures,
 *   and including them can only raise the band. Understating cost is the failure that matters.
 * - **NO CONTENT.** Counts, statuses and ids only.
 */

import type { RunStatus, RunSummary } from "./run-history";

/** How many finished runs the estimator looks back over. */
export const PLAN_HISTORY_WINDOW = 20;

/** Statuses whose counters describe work that actually played out. `blocked` is a park, not an outcome. */
export const FINISHED_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "aborted"];

/** Keep the runs whose revision counters are usable, newest first, capped at the window. */
export function selectPlanHistory(
  runs: RunSummary[],
  limit: number = PLAN_HISTORY_WINDOW,
): RunSummary[] {
  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : PLAN_HISTORY_WINDOW;
  return runs
    .filter((candidate) => FINISHED_RUN_STATUSES.includes(candidate.status))
    // Dropped, not clamped: averaging a malformed row would produce a band that is not merely wrong but
    // unusable, and a cold start is a better answer than a NaN.
    .filter(
      (candidate) => usableCounter(candidate.iterationCount) && usableCounter(candidate.fixCycleCount),
    )
    .slice(0, cap);
}

/** Whether a revision counter can be summed at all. */
function usableCounter(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
