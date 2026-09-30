import { describe, expect, it } from "vitest";
import { InMemoryCostBudgetProvider } from "../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor } from "../agent/lib/dark-factory/cost-governor";
import {
  ReviewBudgetRefusal,
  admitReviewCall,
  createReviewGovernor,
  estimateInputTokens,
  extractOpenRouterCost,
  settleReviewCall,
} from "../scripts/pr-reviewer-budget";

const MODEL = "deepseek/deepseek-chat";

describe("pr-reviewer cost budget integration", () => {
  it("is disabled unless a real budget backend is configured", () => {
    expect(createReviewGovernor({})).toBeNull();
    expect(createReviewGovernor({ DF_COST_BUDGET_DRIVER: "console" })).toBeNull();
    expect(
      createReviewGovernor({
        DF_COST_BUDGET_DRIVER: "postgres",
        DF_COST_BUDGET_DATABASE_URL: "postgresql://example",
      }),
    ).not.toBeNull();
  });

  it("estimates input tokens from prompt characters", () => {
    expect(estimateInputTokens(0)).toBe(1);
    expect(estimateInputTokens(400)).toBe(100);
    expect(estimateInputTokens(401)).toBe(101);
  });

  it("returns an empty admission when governance is disabled", async () => {
    const admission = await admitReviewCall(null, MODEL, 400, 6000);
    expect(admission.reservationId).toBeUndefined();
  });

  it("throws ReviewBudgetRefusal when the call would exceed the cap", async () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), {
      DF_COST_BUDGET_PR_REVIEW_USD: "0.001",
    });
    await expect(
      admitReviewCall(governor, MODEL, 400_000, 6000),
    ).rejects.toBeInstanceOf(ReviewBudgetRefusal);
  });

  it("admits and returns a reservation id when within budget", async () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), {
      DF_COST_BUDGET_PR_REVIEW_USD: "5",
    });
    const admission = await admitReviewCall(governor, MODEL, 4_000, 6_000);
    expect(admission.reservationId).toBeTruthy();
  });

  it("reads the USD cost OpenRouter reports on the usage block", () => {
    expect(extractOpenRouterCost({ usage: { cost: 0.0123 } })).toBe(0.0123);
    expect(extractOpenRouterCost({ usage: { total_cost: 0.5 } })).toBe(0.5);
    expect(extractOpenRouterCost({ usage: {} })).toBeUndefined();
    expect(extractOpenRouterCost({})).toBeUndefined();
    expect(extractOpenRouterCost(null)).toBeUndefined();
    expect(extractOpenRouterCost({ usage: { cost: "free" } })).toBeUndefined();
  });

  it("settling is a no-op when governance is disabled", async () => {
    await expect(settleReviewCall(null, undefined, 1)).resolves.toBeUndefined();
  });
});