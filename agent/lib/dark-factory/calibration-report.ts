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

import { MIN_CALIBRATION_SAMPLES, type CostClass, type CostConfidence } from "./plan-cost-estimate";

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

/** Mean of the observations, or `undefined` when there are none. */
function mean(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * A metric and the number of observations behind it.
 *
 * The count is emitted even when the value is withheld: "we saw 3 runs" and "we saw 3 runs and the
 * figure is not publishable yet" are different findings, and only the count survives a refusal.
 */
function metricOf(values: number[]): Metric {
  return { sampleSize: values.length, value: mean(values) };
}

/**
 * Signed bias first, then the error magnitudes, for one group of pairs.
 *
 * MAPE divides by the actual, so pairs whose actual is zero are excluded from THAT metric only —
 * and its `sampleSize` reports how many survived, rather than the metric silently reading `Infinity`.
 */
function groupMetricsFor(
  pairs: CalibrationPair[],
  expectedOf: (pair: CalibrationPair) => number,
  actualOf: (pair: CalibrationPair) => number,
): GroupMetrics {
  const errors = pairs.map((pair) => expectedOf(pair) - actualOf(pair));
  return {
    bias: metricOf(errors),
    mae: metricOf(errors.map((error) => Math.abs(error))),
    mape: metricOf(
      pairs
        .filter((pair) => actualOf(pair) !== 0)
        .map(
          (pair) =>
            (Math.abs(expectedOf(pair) - actualOf(pair)) / Math.abs(actualOf(pair))) * 100,
        ),
    ),
  };
}

/** Cost classes in ascending order, so a report reads consistently between runs. */
const COST_CLASS_ORDER: CostClass[] = ["XS", "S", "M", "L", "XL"];

/** The minimum sample size a report falls back to when nothing is configured. */
export const DEFAULT_MINIMUM_SAMPLE_SIZE = MIN_CALIBRATION_SAMPLES;

/** The environment variable that raises or lowers that minimum. */
export const MINIMUM_SAMPLE_SIZE_ENV = "DF_CALIBRATION_MIN_SAMPLES";

/**
 * The configured minimum sample, or the default (#490 AC1).
 *
 * A report is an OBSERVATION, not a control, so an unusable value falls back to the default rather
 * than refusing to run — and the caller reports which minimum it used, so the number is never
 * implicit.
 */
export function resolveMinimumSampleSize(env: Record<string, string | undefined>): number {
  const raw = env[MINIMUM_SAMPLE_SIZE_ENV];
  // Digits only: a padded, fractional or exponential value is a configuration mistake, not a
  // sample size, and silently rounding it would hide the typo.
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return DEFAULT_MINIMUM_SAMPLE_SIZE;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : DEFAULT_MINIMUM_SAMPLE_SIZE;
}

/** Build the calibration report. Withholds every metric below the minimum sample size. */
export function buildCalibrationReport(input: CalibrationReportInput): CalibrationReport {
  const pairs = input.pairs;
  const sampleSize = pairs.length;
  const excludedWithoutEstimate = Math.max(0, input.runsWithoutEstimate);
  const wholeRun = groupMetricsFor(
    pairs,
    (pair) => pair.expectedUsd,
    (pair) => pair.actualUsd,
  );

  if (sampleSize < input.minimumSampleSize) {
    // Nothing publishable: the counts come through, no value does. A withheld report must not be
    // mistakable for a clean one that happened to measure zero.
    return {
      reportable: false,
      reason: "below-minimum-sample-size",
      sampleSize,
      excludedWithoutEstimate,
      bias: { sampleSize, value: undefined },
      mae: { sampleSize, value: undefined },
      mape: { sampleSize: wholeRun.mape.sampleSize, value: undefined },
      byStage: [],
      byCostClass: [],
    };
  }

  const stages = [
    ...new Set(
      pairs.flatMap((pair) => [
        ...Object.keys(pair.stageExpectedUsd),
        ...Object.keys(pair.stageActualUsd),
      ]),
    ),
  ]
    .filter((stage) => !EXCLUDED_TASK_TYPES.includes(stage))
    .sort();

  const classes = COST_CLASS_ORDER.filter((costClass) =>
    pairs.some((pair) => pair.costClass === costClass),
  );

  return {
    reportable: true,
    sampleSize,
    excludedWithoutEstimate,
    ...wholeRun,
    byStage: stages.map((stage) => ({
      stage,
      ...groupMetricsFor(
        pairs,
        (pair) => pair.stageExpectedUsd[stage] ?? 0,
        (pair) => pair.stageActualUsd[stage] ?? 0,
      ),
    })),
    byCostClass: classes.map((costClass) => ({
      costClass,
      ...groupMetricsFor(
        pairs.filter((pair) => pair.costClass === costClass),
        (pair) => pair.expectedUsd,
        (pair) => pair.actualUsd,
      ),
    })),
    // Mean of actual / estimate: the multiplicative correction a band built from multipliers needs.
    factor: mean(
      pairs
        .filter((pair) => pair.expectedUsd !== 0)
        .map((pair) => pair.actualUsd / pair.expectedUsd),
    ),
  };
}
