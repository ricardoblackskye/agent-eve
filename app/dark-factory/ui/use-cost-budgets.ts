"use client";

import type { CostBudgetReport } from "../../../agent/lib/dark-factory/cost-budget-query";
import { useRunQuery } from "./use-run-query";

export interface CostBudgetsResponse {
  report: CostBudgetReport;
}

export const COST_BUDGETS_PATH = "/api/dark-factory/cost-budgets";

/** Operator-only, read-only cost-budget read; polls like the other panels. */
export function useCostBudgets(period?: string) {
  const path = period
    ? `${COST_BUDGETS_PATH}?period=${encodeURIComponent(period)}`
    : COST_BUDGETS_PATH;
  return useRunQuery<CostBudgetsResponse>(path);
}