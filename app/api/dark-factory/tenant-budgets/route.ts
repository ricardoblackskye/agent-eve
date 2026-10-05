import { type NextRequest, NextResponse } from "next/server";
import type { CostBudget } from "../../../../agent/lib/dark-factory/cost-budget";
import { createCostBudgetStore } from "../../../../agent/lib/dark-factory/cost-budget-store";
import { buildTenantBudgetReport } from "../../../../agent/lib/dark-factory/tenant-budget-query";
import { createTenantStore } from "../../../../agent/lib/dark-factory/tenant-store-provider";
import { getViewerSession } from "../viewer-auth";
import {
  badRequest,
  okJson,
  serviceUnavailable,
  unauthorized,
} from "../responses";

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
  const viewer = await getViewerSession(request);
  if (!viewer) return unauthorized();

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
    const tenants = await tenantStore.listTenants();
    if (!tenants.ok) return serviceUnavailable("Customer tenants are unavailable");

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