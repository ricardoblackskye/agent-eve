/**
 * Dark Factory — plan-estimate calibration report (#490, epic #453).
 *
 * Closes the loop on the cost estimator: recorded estimate/actual pairs become the SIGNED bias, the
 * error magnitudes and the multiplicative factor the estimator consumes in v2. See ADR 0074.
 *
 * Properties this module must keep:
 *
 * - **PURE.** No store, no clock, no environment, no randomness. Same input produces a
 *   byte-identical report, so a test can pin every metric exactly.
 * - **SIGNED AS `estimate - actual`**, matching `df_plan_estimate_accuracy.signed_error_usd`. A
 *   POSITIVE bias means the estimator was HIGH.
 * - **NO CONTENT.** Counts and money only, never prompts, file contents or issue text.
 * - **EVERY METRIC CARRIES ITS SAMPLE SIZE.** A metric without an `n` is not reportable.
 * - **WITHHOLDS RATHER THAN PUBLISH NOISE.** Below the configured minimum sample size no metric
 *   value is emitted at all, rather than a figure that invites over-reading.
 * - **THE TESTER IS EXCLUDED**, consistent with the estimator's v1 scope.
 */

import type { CostClass, CostConfidence } from "./plan-cost-estimate";

/** Usage task types outside the estimator's scope, so they never reach a metric (AC6). */
export const EXCLUDED_TASK_TYPES: readonly string[] = ["tester"];

/** Why a report withheld its metrics. */
export type CalibrationRefusalReason = "below-minimum-sample-size";

/** One run's estimate/actual pair, already joined on `run_id` by the caller. */
export interface CalibrationPair {
  runId: string;
  costClass: CostClass;
  confidence: CostConfidence;
  expectedUsd: number;
  /** The run's measured spend, excluding any stage in `EXCLUDED_TASK_TYPES`. */
  actualUsd: number;
  /** Per-stage measured spend, keyed by task type. */
  stageActualUsd: Record<string, number>;
  /** Per-stage expectation, keyed by the same task types. Sums to `expectedUsd`. */
  stageExpectedUsd: Record<string, number>;
}

/** A single figure plus the number of observations behind it. */
export interface Metric {
  sampleSize: number;
  value: number | undefined;
}

/** AC2's breakdown: signed bias first, then the error magnitudes, for one group. */
export interface GroupMetrics {
  bias: Metric;
  mae: Metric;
  mape: Metric;
}

export interface StageMetric extends GroupMetrics {
  stage: string;
}

export interface CostClassMetric extends GroupMetrics {
  costClass: CostClass;
}

export interface CalibrationReportInput {
  pairs: CalibrationPair[];
  /** Runs the ledger knows about that carry no estimate. Excluded, never counted as zero. */
  runsWithoutEstimate: number;
  minimumSampleSize: number;
}

export interface CalibrationReport {
  /** False when the sample is too small to publish anything. */
  reportable: boolean;
  reason?: CalibrationRefusalReason;
  sampleSize: number;
  /** Runs excluded for carrying no estimate. Reported whatever the sample size. */
  excludedWithoutEstimate: number;
  /** Mean of `estimate - actual`. Positive means the estimator was HIGH. */
  bias: Metric;
  /** Mean absolute error, in dollars. */
  mae: Metric;
  /** Mean absolute percentage error as a PERCENTAGE (75 means 75%), over pairs with a\n   * non-zero actual — a zero actual is excluded from this metric only. */
  mape: Metric;
  byStage: StageMetric[];
  byCostClass: CostClassMetric[];
  /** Mean of `actual / estimate` — the multiplicative correction v2 consumes. */
  factor?: number;
}

/** Build the calibration report. Withholds every metric below the minimum sample size. */
export function buildCalibrationReport(input: CalibrationReportInput): CalibrationReport {
  throw new Error("not implemented");
}
