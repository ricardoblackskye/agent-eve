/**
 * Dark Factory — a run's actual cost (#531, epic #453).
 *
 * ONE definition of what a run cost, so the value written to `df_run_summaries.cost_usd` cannot
 * diverge from what the calibration report reads. See ADR 0075.
 *
 * A run records its spend to exactly one of two places, by execution path:
 *
 * - `df_usage_events` — the in-process governed calls (the architect, and the reviewer);
 * - the run's own `run.cost` events — the deployed gateway path.
 *
 * The two never overlap, which is what makes summing them correct rather than double counting.
 *
 * Properties this module must keep:
 *
 * - **PURE.** No store, no clock, no environment, no randomness, so a test can pin it exactly.
 * - **ABSENT IS ZERO, NEVER NaN.** A source that recorded nothing contributes 0.
 * - **UNUSABLE VALUES ARE IGNORED.** A negative or non-finite cost is not a cost; ignoring it is
 *   better than propagating it, because the failure that matters is a run looking cheaper than it was.
 * - **NO CONTENT.** Money only, never prompts, file contents or issue text.
 */

/** What a run recorded, per source. Either may be absent when that path recorded nothing. */
export interface RunCostSources {
  /** Summed from the usage ledger for this run. */
  usageCostUsd?: number;
  /** Summed from the run's own cost events, which the gateway writes. */
  eventCostUsd?: number;
}

export interface RunActualCost {
  costUsd: number;
  /** What went into the total, so a reader can tell the two paths apart. */
  sources: { usageCostUsd: number; eventCostUsd: number };
}

/**
 * A usable cost, or 0 for anything that is not one.
 *
 * Absent and unusable are both 0 here on purpose: a run whose ledger read failed should not look like
 * a run that spent a negative amount, and the caller decides separately whether it measured anything
 * at all before writing the total.
 */
function usableCost(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/**
 * Why a value is not a usable cost, or `null` when it is one.
 *
 * The ONE place that decides, so an unused value. A store that writes a negative or non-finite cost
 * has corrupted the very column this change exists to populate.
 */
export function unusableCostReason(costUsd: number | null | undefined): string | null {
  if (costUsd === null) return null;
  if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) {
    return `Run cost '${String(costUsd)}' is not a usable cost.`;
  }
  return null;
}

/** Sum a run's recorded sources into its actual cost. */
export function sumRunActualCost(sources: RunCostSources): RunActualCost {
  const usageCostUsd = usableCost(sources.usageCostUsd);
  const eventCostUsd = usableCost(sources.eventCostUsd);
  return {
    costUsd: usageCostUsd + eventCostUsd,
    sources: { usageCostUsd, eventCostUsd },
  };
}
