/**
 * Dark Factory — per-tenant budget reporting (#231, epic #212 R2).
 *
 * Pure shaping for the operator dashboard: turns the tenant registry plus the
 * tenant-scoped budget rows into a per-customer view. Two honesty rules match
 * the rest of the board:
 *
 *  - An absent measurement stays ABSENT (the UI renders `—`), never `0` — a
 *    zero reads as "this cost nothing" when the truth is "nobody measured it".
 *  - "Store unavailable" and "no budget configured" are DISTINCT from "no
 *    spend", so an operator is not sent hunting for the wrong problem.
 *
 * Counts only — no prompt or completion content.
 */

import type { CostBudget, CostCategory } from "./cost-budget";
import type { Tenant } from "./tenant";

export interface TenantBudgetView {
  tenantId: string;
  name: string;
  category: CostCategory;
  /** Absent when unmeasured/unset — the UI renders an em dash. */
  capUsd?: number;
  settledUsd?: number;
  reservedUsd?: number;
  remainingUsd?: number;
  callCount?: number;
}

export interface TenantBudgetGroup {
  tenantId: string;
  name: string;
  /** False when the tenant has no budget rows at all (distinct from zero spend). */
  configured: boolean;
  budgets: TenantBudgetView[];
}

export interface TenantBudgetReport {
  period: string;
  /** False when the budget store could not be read. */
  available: boolean;
  error?: string;
  tenants: TenantBudgetGroup[];
}

export interface TenantBudgetReportInput {
  tenants: Tenant[];
  budgets: CostBudget[];
  period: string;
  available: boolean;
  error?: string;
}

export function buildTenantBudgetReport(
  input: TenantBudgetReportInput,
): TenantBudgetReport {
  if (!input.available) {
    return {
      period: input.period,
      available: false,
      ...(input.error ? { error: input.error } : {}),
      tenants: [],
    };
  }

  const byTenant = new Map<string, CostBudget[]>();
  for (const budget of input.budgets) {
    if (!budget.tenantId) continue; // global rows are never a customer's
    const list = byTenant.get(budget.tenantId) ?? [];
    list.push(budget);
    byTenant.set(budget.tenantId, list);
  }

  const tenants: TenantBudgetGroup[] = input.tenants.map((tenant) => {
    const rows = byTenant.get(tenant.id) ?? [];
    return {
      tenantId: tenant.id,
      name: tenant.name,
      configured: rows.length > 0,
      budgets: rows.map((row) => {
        const reserved = row.reservedUsd;
        return {
          tenantId: tenant.id,
          name: tenant.name,
          category: row.category,
          capUsd: row.capUsd,
          settledUsd: row.spentUsd,
          // An unrecorded accumulator stays ABSENT rather than becoming a zero.
          ...(reserved === undefined ? {} : { reservedUsd: reserved }),
          remainingUsd: row.capUsd - row.spentUsd - (reserved ?? 0),
          callCount: row.callCount,
        };
      }),
    };
  });

  return { period: input.period, available: true, tenants };
}