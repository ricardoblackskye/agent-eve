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

import { resolvePrice, type ModelPrice } from "./cost-budget";
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
  throw new Error("not implemented");
}

/**
 * Clamp a token count to a non-negative integer. Negative, `NaN` and non-finite inputs become 0
 * rather than propagating a negative cost into the band.
 */
export function clampTokenCount(count: number): number {
  throw new Error("not implemented");
}

/** Estimate what a plan is likely to cost, as a band. Never blocks anything. */
export function estimatePlanCost(input: EstimatePlanCostInput): PlanCostEstimate {
  throw new Error("not implemented");
}
