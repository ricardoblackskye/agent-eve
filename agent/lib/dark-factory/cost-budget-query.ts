/**
 * Dark Factory — cost-budget read query (#208 R1 task 7).
 *
 * Pure shaping for the operator dashboard: validates the period filter, maps
 * stored rows into a display view with a computed remaining amount, and sums
 * totals. Operator-only and read-only; no prompts/completions are involved.
 */

import { COST_CATEGORIES, type CostBudget, type CostCategory } from "./cost-budget";
import type { CostBudgetStore } from "./cost-budget-store";

export interface CostBudgetView {
  category: CostCategory;
  period: string;
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  callCount: number;
}

export interface CostBudgetTotals {
  capUsd: number;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  callCount: number;
}

export interface CostBudgetReport {
  period: string;
  /** One entry per canonical category; `null` where no budget row exists. */
  budgets: Array<CostBudgetView | null>;
  totals: CostBudgetTotals;
}

export type CostBudgetQueryResult =
  | { ok: true; report: CostBudgetReport }
  | { ok: false; status: 400 | 503; error: string };

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

function toView(budget: CostBudget): CostBudgetView {
  const reservedUsd = budget.reservedUsd ?? 0;
  return {
    category: budget.category,
    period: budget.period,
    capUsd: budget.capUsd,
    spentUsd: budget.spentUsd,
    reservedUsd,
    remainingUsd: Math.max(0, budget.capUsd - budget.spentUsd - reservedUsd),
    callCount: budget.callCount,
  };
}

export async function queryCostBudgets(
  store: CostBudgetStore,
  params: { period?: string } = {},
): Promise<CostBudgetQueryResult> {
  const period = (params.period ?? "").trim();
  if (period !== "" && !PERIOD_PATTERN.test(period)) {
    return { ok: false, status: 400, error: "period must be a YYYY-MM month" };
  }

  const read = await store.listBudgets(period === "" ? undefined : period);
  if (!read.ok) {
    return {
      ok: false,
      status: 503,
      error: read.error ?? "Cost budget store is unavailable",
    };
  }

  const byCategory = new Map<CostCategory, CostBudgetView>();
  for (const budget of read.value) {
    byCategory.set(budget.category, toView(budget));
  }

  // Always render every canonical category so a missing budget shows as an
  // explicit gap rather than a misleading 0.
  const budgets = COST_CATEGORIES.map((category) => byCategory.get(category) ?? null);
  const present = budgets.filter((view): view is CostBudgetView => view !== null);

  const totals: CostBudgetTotals = present.reduce<CostBudgetTotals>(
    (acc, view) => ({
      capUsd: acc.capUsd + view.capUsd,
      spentUsd: acc.spentUsd + view.spentUsd,
      reservedUsd: acc.reservedUsd + view.reservedUsd,
      remainingUsd: acc.remainingUsd + view.remainingUsd,
      callCount: acc.callCount + view.callCount,
    }),
    { capUsd: 0, spentUsd: 0, reservedUsd: 0, remainingUsd: 0, callCount: 0 },
  );

  return {
    ok: true,
    report: {
      period: period === "" ? (present[0]?.period ?? "") : period,
      budgets,
      totals,
    },
  };
}