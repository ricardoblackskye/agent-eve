/**
 * Dark Factory — recording a run's actual cost (#531, epic #453).
 *
 * Reads what a run recorded, sums it with `sumRunActualCost`, and writes it where
 * `df_plan_estimate_accuracy` reads it. See ADR 0075.
 *
 * Properties this module must keep:
 *
 * - **BEST-EFFORT.** A cost is an observation about a run, not a control over it. Every failure is
 *   reported as a result and logged; none is thrown, because no run should die over its own
 *   bookkeeping.
 * - **NOTHING MEASURED WRITES NOTHING.** When neither source recorded anything, the run is left
 *   unmeasured rather than set to 0: "free" and "not measured" are different findings.
 * - **RECOMPUTE, NEVER ACCUMULATE.** The value is always the whole sum, so re-running it replaces
 *   rather than adds and a resumed run grows its total.
 * - **NO CONTENT.** Money and counts only.
 */

import { EXCLUDED_TASK_TYPES } from "./calibration-report";
import { sumRunActualCost, type RunActualCost } from "./run-actual-cost";
import { queryUsage } from "./usage-query";
import type { RunHistoryStore } from "./run-history-store";

/** The narrow slice of the stores this needs, so a test can supply its own. */
export interface RunCostRecorderDeps {
  runHistory: Pick<RunHistoryStore, "recordRunCost" | "listRunEvents" | "id">;
  usage: Parameters<typeof queryUsage>[0];
}

/** Why a run cost was not written, or `ok` when it was. */
export type RunCostRecordReason = "not-measured" | "usage-unreadable" | "write-failed";

export interface RunCostRecordResult {
  ok: boolean;
  reason?: RunCostRecordReason;
  error?: string;
  /** The total and its parts, present only when a write was attempted. */
  actual?: RunActualCost;
}

/** Record a run's actual cost from what it recorded. Never throws. */
export async function recordRunActualCost(
  deps: RunCostRecorderDeps,
  runId: string,
): Promise<RunCostRecordResult> {
  throw new Error("not implemented");
}
