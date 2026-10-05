import { describe, expect, it } from "vitest";
import { InMemoryCostBudgetProvider } from "../../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor } from "../../agent/lib/dark-factory/cost-governor";
import { createWorkerCostClient } from "../../agent/lib/dark-factory/worker-cost-client";

const PERIOD = "2026-10";
const ENV = {
  DF_COST_BUDGET_PERIOD: PERIOD,
  DF_COST_BUDGET_ORCHESTRATOR_USD: "10",
  DF_COST_BUDGET_DEVELOPER_USD: "10",
  DF_COST_BUDGET_TESTER_USD: "10",
  DF_COST_BUDGET_PR_REVIEW_USD: "10",
};
const MODEL = "deepseek/deepseek-chat";

describe("createWorkerCostClient (#218)", () => {
  it("reserves against the tenant's own budget and settles to actual cost", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "orchestrator", 10, "tenant-a");
    const client = createWorkerCostClient(createCostGovernor(store, ENV), store);

    const reserved = await client.reserve({
      tenantId: "tenant-a",
      category: "orchestrator",
      model: MODEL,
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;

    await client.settle(reserved.reservationId, 0.0042);
    const [budget] = (await store.listTenantBudgets("tenant-a", PERIOD)).value;
    expect(budget.spentUsd).toBeCloseTo(0.0042);
    expect(budget.callCount).toBe(1);
    expect(budget.reservedUsd).toBeCloseTo(0); // reconciled away
  });

  it("refuses when the tenant has no provisioned budget", async () => {
    const store = new InMemoryCostBudgetProvider();
    const client = createWorkerCostClient(createCostGovernor(store, ENV), store);
    const reserved = await client.reserve({
      tenantId: "tenant-x",
      category: "orchestrator",
      model: MODEL,
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(reserved.ok).toBe(false);
    if (reserved.ok) return;
    expect(reserved.reason).toBe("tenant_unconfigured");
    expect(reserved.tenantId).toBe("tenant-x");
  });
});