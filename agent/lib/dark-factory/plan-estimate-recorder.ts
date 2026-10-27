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
  type PlanCostEstimate,
} from "./plan-cost-estimate";
import type {
  PersistedPlanEstimate,
  PlanEstimateRecordInput,
  PlanLedger,
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
export async function recordPlanEstimateSafely(
  ledger: PlanLedger,
  input: RecordPlanEstimateInput,
): Promise<PlanEstimateRecordResult> {
  throw new Error("not implemented");
}

/** Exported for the record-shape tests; the ledger's input type is the contract. */
export type { PlanEstimateRecordInput };
