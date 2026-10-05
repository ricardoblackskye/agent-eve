import { type NextRequest, NextResponse } from "next/server";
import type { CostBudget } from "../../../../agent/lib/dark-factory/cost-budget";
import { createCostBudgetStore } from "../../../../agent/lib/dark-factory/cost-budget-store";
import { buildTenantBudgetReport } from "../../../../agent/lib/dark-factory/tenant-budget-query";
import { createTenantStore } from "../../../../agent/lib/dark-factory/tenant-store-provider";
import { guardViewer } from "../guard";
import { badRequest, okJson, serviceUnavailable } from "../responses";

const PERIOD_PATTERN = /^\d{4}-\d{2}$/;

/**
 * Operator-only, read-only view of the per-customer LLM budgets (#231, epic #212 R2).
 *
 * An unreadable budget store is reported as `available: false` with its own
 * message — NOT as an empty (zero-spend) report and not as a 503 page — so the
 * dashboard can show the two states distinctly.
 *
 * Counts and identifiers only: no issue text, no prompt or completion content.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await guardViewer(request);
  if (!guard.ok) return guard.response;

  const period = (new URL(request.url).searchParams.get("period") ?? "").trim();
  if (period !== "" && !PERIOD_PATTERN.test(period)) {
    return badRequest("period must be a YYYY-MM month");
  }

  let tenantStore;
  let budgetStore;
  try {
    tenantStore = createTenantStore();
    budgetStore = createCostBudgetStore();
  } catch {
    return serviceUnavailable("Customer budgets are unavailable");
  }

  try {
    const all = await tenantStore.listTenants();
    if (!all.ok) return serviceUnavailable("Customer tenants are unavailable");
    // A customer sees only their own tenant's budgets; an operator sees every
    // tenant. Scope comes from the membership, never from the request.
    const tenants = {
      ...all,
      value:
        guard.viewer.role === "operator"
          ? all.value
          : all.value.filter((tenant) => tenant.id === guard.viewer.tenantId),
    };

    const budgets: CostBudget[] = [];
    for (const tenant of tenants.value) {
      const read = await budgetStore.listTenantBudgets(
        tenant.id,
        period === "" ? undefined : period,
      );
      if (!read.ok) {
        return okJson({
          report: buildTenantBudgetReport({
            tenants: tenants.value,
            budgets: [],
            period,
            available: false,
            error: read.error ?? "Cost budget store is unavailable",
          }),
        });
      }
      budgets.push(...read.value);
    }

    return okJson({
      report: buildTenantBudgetReport({
        tenants: tenants.value,
        budgets,
        period,
        available: true,
      }),
    });
  } finally {
    await tenantStore.close?.();
    await budgetStore.close?.();
  }
}
