"use client";

import type { TenantBudgetReport } from "../../../agent/lib/dark-factory/tenant-budget-query";
import { useRunQuery } from "./use-run-query";

export interface TenantBudgetResponse {
  report: TenantBudgetReport;
}

export const TENANT_BUDGETS_PATH = "/api/dark-factory/tenant-budgets";

export interface TenantBudgetWindow {
  /** `YYYY-MM`; omit for the store's current period. */
  period?: string;
}

/** Operator-only, read-only read of the per-customer budget state (#231). */
export function useTenantBudgets(window: TenantBudgetWindow = {}) {
  const params = new URLSearchParams();
  if (window.period) params.set("period", window.period);
  const query = params.toString();

  const read = useRunQuery<TenantBudgetResponse>(
    query ? `${TENANT_BUDGETS_PATH}?${query}` : TENANT_BUDGETS_PATH,
  );

  return {
    report: read.data?.report ?? null,
    loading: read.loading,
    error: read.error,
    refresh: read.refresh,
  };
}