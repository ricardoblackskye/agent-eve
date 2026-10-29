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

/** Costs that are actual numbers, since an unmeasured row carries none. */
function sumDefined(values: Array<number | undefined>): number | undefined {
  const costs = values.filter((value): value is number => typeof value === "number");
  if (costs.length === 0) return undefined;
  return costs.reduce((total, value) => total + value, 0);
}

/** Record a run's actual cost from what it recorded. Never throws. */
export async function recordRunActualCost(
  deps: RunCostRecorderDeps,
  runId: string,
): Promise<RunCostRecordResult> {
  // The ledger: the in-process governed calls. The tester is filtered out to match the estimator's
  // own scope (ADR 0074), so the pair compares like with like.
  let usageCostUsd: number | undefined;
  try {
    const report = await queryUsage(deps.usage, { runId });
    if (!report.ok) {
      return { ok: false, reason: "usage-unreadable", error: report.error };
    }
    usageCostUsd = sumDefined(
      (report.report.byTaskType ?? [])
        .filter((entry) => !EXCLUDED_TASK_TYPES.includes(entry.taskType))
        .map((entry) => entry.costUsd),
    );
  } catch (error) {
    return {
      ok: false,
      reason: "usage-unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // The run's own cost events: the other subsystem, written by the gateway path.
  let eventCostUsd: number | undefined;
  try {
    const events = await deps.runHistory.listRunEvents(runId);
    if (events.ok) {
      eventCostUsd = sumDefined(
        (events.value?.items ?? [])
          .filter((entry) => entry.event.type === "run.cost")
          .map((entry) => entry.event.costUsd),
      );
    }
  } catch (error) {
    // Best-effort: an unreadable event log costs us the gateway side of the total, not the run.
    console.warn(
      `[WARN] The run's cost events could not be read, so its cost may be understated: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (usageCostUsd === undefined && eventCostUsd === undefined) {
    // NOT measured: writing 0 here would claim the run was free.
    return { ok: false, reason: "not-measured" };
  }

  const actual = sumRunActualCost({ usageCostUsd, eventCostUsd });
  try {
    const written = await deps.runHistory.recordRunCost(runId, actual.costUsd);
    if (!written.ok) {
      return { ok: false, reason: "write-failed", error: written.error, actual };
    }
    return { ok: true, actual };
  } catch (error) {
    return {
      ok: false,
      reason: "write-failed",
      error: error instanceof Error ? error.message : String(error),
      actual,
    };
  }
}
