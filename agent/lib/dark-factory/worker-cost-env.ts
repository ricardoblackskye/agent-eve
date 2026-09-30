/**
 * Dark Factory — worker cost-budget contract (#208 R1 task 6).
 *
 * The sandbox never receives a database URL or a credential. Instead it
 * receives a small, non-secret contract telling it WHICH cost category its LLM
 * calls belong to and that governance is active; the orchestrator owns the
 * store and adjudicates the reserve/settle calls. Returns `null` when
 * governance is disabled so an unconfigured deployment is unchanged.
 */

import type { CostCategory } from "./cost-budget";
import { isCostGovernanceConfigured } from "./cost-budget-store";

/** The worker surfaces that consume an LLM budget. */
export type WorkerCostCategory = Extract<CostCategory, "developer" | "tester">;

export interface WorkerCostBudgetEnv {
  category: WorkerCostCategory;
  /** Non-secret env values injected into the sandbox (names/values, no secrets). */
  env: Record<string, string>;
}

export const WORKER_COST_CATEGORY_VAR = "DF_COST_BUDGET_CATEGORY";
export const WORKER_COST_ENABLED_VAR = "DF_COST_BUDGET_GOVERNED";
export const WORKER_COST_PERIOD_VAR = "DF_COST_BUDGET_PERIOD";

/**
 * Build the cost contract for a worker task. `null` means "not governed" — the
 * worker must then run exactly as before rather than guessing a cap.
 */
export function buildWorkerCostEnv(
  category: WorkerCostCategory,
  env: Record<string, string | undefined> = process.env,
): WorkerCostBudgetEnv | null {
  if (!isCostGovernanceConfigured(env)) return null;
  const period = (env.DF_COST_BUDGET_PERIOD ?? "").trim();
  return {
    category,
    env: {
      [WORKER_COST_CATEGORY_VAR]: category,
      [WORKER_COST_ENABLED_VAR]: "true",
      [WORKER_COST_PERIOD_VAR]: period,
    },
  };
}