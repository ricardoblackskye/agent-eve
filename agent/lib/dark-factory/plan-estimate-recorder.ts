/**
 * Dark Factory - record a plan's cost estimate, best-effort (#487, epic #453).
 *
 * The WIRING half of the estimator. `estimatePlanCost` (#485) computes a band from a validated plan;
 * `PlanLedger` (#486) persists rows. This module joins them without letting a persistence problem
 * reach the run.
 *
 * WHY BEST-EFFORT, AND WHY THAT CONTRASTS WITH `readPlanRevisionCount`
 *
 * The plan revision cap FAILS CLOSED on an unreadable ledger, deliberately: a cap that silently
 * reads zero lets a run through a limit the operator believes is enforced. An ESTIMATE is the
 * opposite kind of thing. It is an OBSERVATION about a run, not a control over it, so failing a run
 * because we could not record a forecast would trade real work for bookkeeping. Every suppressed
 * failure is returned AND logged, so best-effort never means silently broken.
 *
 * A mapping failure is treated the same way as a store failure, and deliberately does NOT write a
 * row. The typed columns are derived from the estimator's `features`; if a feature key is absent
 * (a future estimator renaming one), writing a zero-filled row would invent numbers and put them in
 * the calibration rollup. Refusing to record is the honest outcome - the band is simply absent, which
 * the ledger already models as "not priced".
 */

import type { ExecutionPlan } from "./plan-validator";
import type { ModelPrice } from "./cost-budget";
import type { RunSummary } from "./run-history";
import {
  PLAN_ESTIMATOR_VERSION,
  estimatePlanCost,
  type PlanCostEstimate,
} from "./plan-cost-estimate";
import type {
  PersistedPlan,
  PersistedPlanEstimate,
  PlanCommentRef,
  PlanEstimateRecordInput,
  PlanLedger,
  PlanSource,
} from "./plan-ledger";

export interface RecordPlanEstimateInput {
  /** The VALIDATED plan - the one the run will execute. */
  plan: ExecutionPlan;
  /** Identity of the persisted plan row; an estimate is a child of a plan. */
  planId: number;
  runId: string;
  /** The model the run will use. */
  model: string;
  /** Cost-budget period key, `YYYY-MM`. */
  period: string;
  tenantId?: string;
  /** NULL is whole-run; per-stage attribution is #492. */
  stage?: string;
  /** Prior runs for the revision factor. Absent is the cold start, marked low confidence. */
  history?: RunSummary[];
  now?: Date;
  resolvePrice?: (model: string | null | undefined) => ModelPrice | null;
  /** Injectable so a test can drive a mapping failure the real estimator never produces. */
  estimate?: (plan: ExecutionPlan) => PlanCostEstimate;
}

export type PlanEstimateRecordResult =
  | { ok: true; estimate: PersistedPlanEstimate; computed: PlanCostEstimate }
  | { ok: false; error: string };

/**
 * Compute and persist one estimate. Never throws: a store that rejects, or a feature the typed
 * columns cannot be derived from, both come back as `{ ok: false, error }`.
 */
/** The numeric typed columns, every one derived from a feature the estimator emits. */
const NUMERIC_FEATURE_KEYS = [
  "targetFileCount",
  "taskCount",
  "inputTokens",
  "outputTokens",
  "revisionFactor",
  "historySampleCount",
] as const;

type NumericFeatureKey = (typeof NUMERIC_FEATURE_KEYS)[number];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A finite feature number, or null when the key is absent or unusable. */
function featureNumber(
  features: Record<string, number | string>,
  key: NumericFeatureKey,
): number | null {
  const value = features[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export async function recordPlanEstimateSafely(
  ledger: PlanLedger,
  input: RecordPlanEstimateInput,
): Promise<PlanEstimateRecordResult> {
  const compute =
    input.estimate ??
    ((plan: ExecutionPlan) =>
      estimatePlanCost({
        plan,
        model: input.model,
        history: input.history,
        resolvePrice: input.resolvePrice,
      }));

  let computed: PlanCostEstimate;
  try {
    computed = compute(input.plan);
  } catch (error) {
    const message = `the estimate could not be computed: ${errorMessage(error)}`;
    console.warn(`[WARN] ${message}`);
    return { ok: false, error: message };
  }

  // Refuse rather than invent. A missing feature means the estimator's contract moved, and a
  // zero-filled row would enter the calibration rollup as a real measurement.
  const features = computed.features ?? {};
  const columns = {} as Record<NumericFeatureKey, number>;
  for (const key of NUMERIC_FEATURE_KEYS) {
    const value = featureNumber(features, key);
    if (value === null) {
      return {
        ok: false,
        error: `the estimate's features carry no usable "${key}", so no row was written`,
      };
    }
    columns[key] = value;
  }
  const priceSource = features.priceSource;
  if (typeof priceSource !== "string" || priceSource === "") {
    return {
      ok: false,
      error: 'the estimate\'s features carry no usable "priceSource", so no row was written',
    };
  }

  const row: PlanEstimateRecordInput = {
    planId: input.planId,
    runId: input.runId,
    period: input.period,
    // Stamped EXPLICITLY: the stores default it, but a write payload should state its intent
    // rather than inherit a default that could change under it and mislabel every row.
    estimatorVersion: PLAN_ESTIMATOR_VERSION,
    model: input.model,
    lowUsd: computed.lowUsd,
    expectedUsd: computed.expectedUsd,
    highUsd: computed.highUsd,
    costClass: computed.costClass,
    confidence: computed.confidence,
    revisionFactor: columns.revisionFactor,
    historySamples: columns.historySampleCount,
    targetFileCount: columns.targetFileCount,
    taskCount: columns.taskCount,
    inputTokens: columns.inputTokens,
    outputTokens: columns.outputTokens,
    priceSource,
    features,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  // Assigned only when supplied: an explicit `undefined` is not the same as an absent optional.
  if (input.tenantId !== undefined) row.tenantId = input.tenantId;
  if (input.stage !== undefined) row.stage = input.stage;

  try {
    const estimate = await ledger.recordPlanEstimate(row);
    return { ok: true, estimate, computed };
  } catch (error) {
    // Best-effort BY DESIGN. An estimate is an observation, not a control, so a ledger outage is
    // reported and logged rather than allowed to fail the run.
    const message = errorMessage(error);
    console.warn(`[WARN] The plan estimate could not be recorded: ${message}`);
    return { ok: false, error: message };
  }
}

/** A plan plus its estimate, as the runner supplies them: no plan identity yet. */
export interface RecordPlanWithEstimateInput
  extends Omit<RecordPlanEstimateInput, "planId"> {
  /** Which revision this plan is. A run can legitimately produce several (#378). */
  planRevision: number;
  storyId: number;
  /** `architect` for the first plan, `amendment` for a re-plan after feedback. */
  source: PlanSource;
  /** The comment the plan text lives in. Omitted when the post did not report an id. */
  commentRef?: PlanCommentRef;
}

export type RecordPlanWithEstimateResult =
  | {
      ok: true;
      plan: PersistedPlan;
      estimate?: PersistedPlanEstimate;
      /** Set when the plan landed but its estimate did not. The estimate is the secondary record. */
      estimateError?: string;
    }
  | { ok: false; error: string };

/**
 * Persist the plan row, then its estimate. Best-effort in the same sense as the recorder: a ledger
 * that rejects is reported and logged, never thrown.
 *
 * The two are not treated as equally important. The PLAN is the primary record of what the run
 * intends, so a plan that fails to persist is a failure and no estimate is attempted (an estimate is
 * a child of a plan row). An ESTIMATE that fails leaves the plan intact and reports separately, so a
 * pricing problem cannot cost the run its plan.
 */
export async function recordPlanWithEstimateSafely(
  ledger: PlanLedger,
  input: RecordPlanWithEstimateInput,
): Promise<RecordPlanWithEstimateResult> {
  throw new Error("not implemented");
}

/** Exported for the record-shape tests; the ledger's input type is the contract. */
export type { PlanEstimateRecordInput };
