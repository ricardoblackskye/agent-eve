import { type NextRequest, NextResponse } from "next/server";
import { createCostBudgetStore } from "../../../../agent/lib/dark-factory/cost-budget-store";
import { queryCostBudgets } from "../../../../agent/lib/dark-factory/cost-budget-query";
import { getViewerSession } from "../viewer-auth";
import {
  badRequest,
  okJson,
  serviceUnavailable,
  unauthorized,
} from "../responses";

/**
 * Operator-only, read-only view of the LLM cost budgets. Reuses the shared
 * signed-session gate and structured response helpers, and never exposes
 * prompt/completion content.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const viewer = await getViewerSession(request);
  if (!viewer) return unauthorized();

  const store = createCostBudgetStore();
  try {
    const outcome = await queryCostBudgets(store, {
      period: new URL(request.url).searchParams.get("period") ?? undefined,
    });
    if (!outcome.ok) {
      return outcome.status === 400
        ? badRequest(outcome.error)
        : serviceUnavailable("Cost budgets are unavailable");
    }
    return okJson({ report: outcome.report });
  } finally {
    await store.close?.();
  }
}