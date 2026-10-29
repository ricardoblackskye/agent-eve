/**
 * Dark Factory — plan-level cost estimate (#485, epic #453).
 *
 * Turns a validated `ExecutionPlan` plus prior run history into an advisory cost BAND, a cost
 * class and a confidence label. Deliberately NOT a single number: measured run-to-run variance
 * for the same task is large, so a point estimate would imply precision the data does not
 * support. See ADR 0069.
 *
 * Properties this module must keep:
 *
 * - **PURE.** No network, no model call, no filesystem write, no clock, no randomness. Same
 *   inputs produce a byte-identical result, so a test can pin the band exactly.
 * - **ONE PRICE SOURCE.** Prices come from the governor's own `resolvePrice`, so a plan estimate
 *   can never disagree with a reservation. The seam is injectable so tests can move a price
 *   without mutating the environment.
 * - **ADVISORY ONLY.** It never blocks, refuses or gates anything. It has no authority.
 * - **NO CONTENT.** Features are counts, token estimates and prices. No prompts, no file
 *   contents, no issue text — the same privacy contract as `UsageEvent`.
 *
 * Input-token-centric by design: the epic's research pass found context ingestion dominates
 * agentic coding cost, and that output-line counts are a weak predictor.
 */

import { modelPriceTable, resolvePrice, type ModelPrice } from "./cost-budget";
import type { ExecutionPlan } from "./plan-validator";
import type { RunSummary } from "./run-history";

/** Chars per token. Matches the runner's own `prompt.length / 4` reservation. */
export const CHARS_PER_TOKEN = 4;

/** Bound on how many files a run ingests. Mirrors the Architect's bounded reader (#381 R1). */
export const MAX_CONTEXT_FILES_READ = 24;

/** Bound on how much of each file is read. Mirrors the Architect's bounded reader (#381 R1). */
export const MAX_CHARS_PER_FILE = 12_000;

/**
 * How many times a run ingests the target-file context: once when the Architect plans, and once
 * when the developer implements. A structural working number, not a measurement.
 */
export const CONTEXT_READS_PER_RUN = 2;

/** The Architect's planning call output. Mirrors the runner's own reservation. */
export const ARCHITECT_OUTPUT_TOKENS = 8_000;

/** Working estimate of output tokens per planned task. Structural, not measured. */
export const OUTPUT_TOKENS_PER_TASK = 2_000;

/** Lower band edge as a multiple of the expectation. A placeholder — #490 calibrates it. */
export const BAND_LOW_MULTIPLIER = 0.5;

/** Upper band edge as a multiple of the expectation. A placeholder — #490 calibrates it. */
export const BAND_HIGH_MULTIPLIER = 2;

/** History size at which confidence stops being "medium". */
export const MIN_CALIBRATION_SAMPLES = 10;

/**
 * Identity of the constant set that produced a band (#486).
 *
 * Stamped onto every persisted estimate so a later recalibration (#490) can never be averaged
 * together with bands produced by a different model. Bump this whenever a constant below changes.
 */
export const PLAN_ESTIMATOR_VERSION = "v1";

/** Absolute cost classes, anchored to the monthly orchestrator cap. */
export type CostClass = "XS" | "S" | "M" | "L" | "XL";

export type CostConfidence = "low" | "medium" | "high";

export interface EstimatePlanCostInput {
  plan: ExecutionPlan;
  /** The model the run will use; an unknown id yields a conservative band, never a throw. */
  model: string;
  /** Prior runs used to calibrate the revision factor. Absent or empty is the cold start. */
  history?: RunSummary[];
  /** Defaults to the governor's own `resolvePrice` — one price source of truth. */
  resolvePrice?: (model: string | null | undefined) => ModelPrice | null;
}

export interface PlanCostEstimate {
  lowUsd: number;
  expectedUsd: number;
  highUsd: number;
  costClass: CostClass;
  confidence: CostConfidence;
  /** Numeric and structural only — never prompts, file contents or issue text. */
  features: Record<string, number | string>;
}

/**
 * Absolute cost class for an estimate. A value exactly on an edge lands in the UPPER class.
 */
export function classifyCost(usd: number): CostClass {
  // A non-finite value is not a cost; treat it as the smallest class rather than propagating NaN.
  if (!Number.isFinite(usd) || usd < 0.25) return "XS";
  if (usd < 1) return "S";
  if (usd < 5) return "M";
  if (usd < 20) return "L";
  return "XL";
}

/**
 * Clamp a token count to a non-negative integer. Negative, `NaN` and non-finite inputs become 0
 * rather than propagating a negative cost into the band.
 */
export function clampTokenCount(count: number): number {
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return 0;
  return Math.floor(count);
}

/**
 * The dearest rate in the table, used when a model has no known price.
 *
 * The alternative — costing an unknown model at zero — understates the run, and understating is
 * the failure that matters: it makes an expensive run look free. Overstating is merely visible.
 */
function ceilingPrice(): ModelPrice {
  const rates = Object.values(modelPriceTable);
  return {
    inputUsdPer1k: Math.max(...rates.map((rate) => rate.inputUsdPer1k)),
    outputUsdPer1k: Math.max(...rates.map((rate) => rate.outputUsdPer1k)),
  };
}

/**
 * How much to scale a structural estimate by, given what prior runs actually needed.
 *
 * Uses the revision counters already recorded on every `RunSummary`, so this needs no new
 * instrumentation. Never below 1: a history of unusually cheap runs must not shrink the band,
 * because understating cost is the failure that matters.
 */
function revisionFactorFor(history: RunSummary[]): number {
  if (history.length === 0) return 1;
  const total = history.reduce(
    (sum, run) => sum + run.iterationCount + run.fixCycleCount + 1,
    0,
  );
  return Math.max(1, total / history.length);
}

/** Coarse on purpose: dispersion-aware confidence needs the estimate/actual pairs #490 builds. */
function confidenceFor(history: RunSummary[]): CostConfidence {
  if (history.length === 0) return "low";
  return history.length < MIN_CALIBRATION_SAMPLES ? "medium" : "high";
}

/** Estimate what a plan is likely to cost, as a band. Never blocks anything. */
export function estimatePlanCost(input: EstimatePlanCostInput): PlanCostEstimate {
  const plan = input.plan;
  const targetFiles = plan.targetFiles ?? [];
  const targetFileCount = clampTokenCount(targetFiles.length);
  const taskCount = clampTokenCount((plan.tasks ?? []).length);

  // Context ingestion dominates agentic coding cost, so the structural model is built from the
  // files a run must read — bounded exactly as the Architect's reader bounds them.
  const contextFiles = Math.min(targetFileCount, MAX_CONTEXT_FILES_READ);
  const contextTokens = clampTokenCount(contextFiles * (MAX_CHARS_PER_FILE / CHARS_PER_TOKEN));
  const inputTokens = clampTokenCount(contextTokens * CONTEXT_READS_PER_RUN);
  const outputTokens = clampTokenCount(
    ARCHITECT_OUTPUT_TOKENS + taskCount * OUTPUT_TOKENS_PER_TASK,
  );

  // ONE PRICE SOURCE: default to the governor's own resolver so a plan estimate can never
  // disagree with a reservation. The seam is injectable purely so a test can move a price.
  const priceOf = input.resolvePrice ?? resolvePrice;
  const resolved = priceOf(input.model);
  const price = resolved ?? ceilingPrice();
  const priceSource = resolved ? "known-model" : "unknown-model-ceiling";
  const history = input.history ?? [];
  const baseUsd =
    (inputTokens / 1000) * price.inputUsdPer1k +
    (outputTokens / 1000) * price.outputUsdPer1k;
  const revisionFactor = revisionFactorFor(history);
  const expectedUsd = baseUsd * revisionFactor;

  return {
    lowUsd: expectedUsd * BAND_LOW_MULTIPLIER,
    expectedUsd,
    highUsd: expectedUsd * BAND_HIGH_MULTIPLIER,
    costClass: classifyCost(expectedUsd),
    confidence: confidenceFor(history),
    features: {
      targetFileCount,
      taskCount,
      inputTokens,
      outputTokens,
      priceInputUsdPer1k: price.inputUsdPer1k,
      priceOutputUsdPer1k: price.outputUsdPer1k,
      priceSource,
      revisionFactor,
      historySampleCount: history.length,
    },
  };
}


/**
 * The plan's estimate, or undefined when it cannot be computed (#488, epic #453).
 *
 * The band is an OBSERVATION about a run, not a control over it: a plan that cannot be priced must still
 * post a readable comment, so a failure here is reported and yields no estimate rather than stopping the
 * dispatch. This is the compute-side twin of `recordPlanEstimateSafely` (#487) on the persistence side.
 *
 * The price source is injectable, so the failure path is REACHABLE in a test (a resolver that throws)
 * instead of theoretical — the guard is exercised, not merely written.
 */
export function estimatePlanCostSafely(
  input: EstimatePlanCostInput,
): PlanCostEstimate | undefined {
  try {
    return estimatePlanCost(input);
  } catch (error) {
    console.warn(
      `[WARN] The plan estimate could not be computed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}


/**
 * One stage's share of a plan's expected cost (#490).
 *
 * Derived from the SAME constants as the band, so the parts always sum to `expectedUsd`: the
 * Architect spends one context read plus its planning output, the developer the other read plus the
 * per-task output. Splitting `CONTEXT_READS_PER_RUN` one read per stage is STRUCTURAL, not measured
 * — the same caveat that constant already carries.
 */
export interface PlanCostStageEstimate {
  stage: "architect" | "developer";
  expectedUsd: number;
}

/** Split a plan's expected cost across the stages that spend it (#490). Parts sum to the band. */
export function decomposePlanCostEstimate(
  input: EstimatePlanCostInput,
): PlanCostStageEstimate[] {
  const plan = input.plan;
  const targetFileCount = clampTokenCount((plan.targetFiles ?? []).length);
  const taskCount = clampTokenCount((plan.tasks ?? []).length);

  const contextFiles = Math.min(targetFileCount, MAX_CONTEXT_FILES_READ);
  const contextTokens = clampTokenCount(contextFiles * (MAX_CHARS_PER_FILE / CHARS_PER_TOKEN));
  // One context read per stage; the band charges CONTEXT_READS_PER_RUN reads in total.
  const readTokens = clampTokenCount(contextTokens * (CONTEXT_READS_PER_RUN / 2));

  const priceOf = input.resolvePrice ?? resolvePrice;
  const resolved = priceOf(input.model);
  const price = resolved ?? ceilingPrice();
  // The same factor the band applies, so the parts keep summing to `expectedUsd` with history.
  const revisionFactor = revisionFactorFor(input.history ?? []);

  const stageUsd = (outputTokens: number): number =>
    ((readTokens / 1000) * price.inputUsdPer1k + (outputTokens / 1000) * price.outputUsdPer1k) *
    revisionFactor;

  return [
    { stage: "architect", expectedUsd: stageUsd(clampTokenCount(ARCHITECT_OUTPUT_TOKENS)) },
    {
      stage: "developer",
      expectedUsd: stageUsd(clampTokenCount(taskCount * OUTPUT_TOKENS_PER_TASK)),
    },
  ];
}
