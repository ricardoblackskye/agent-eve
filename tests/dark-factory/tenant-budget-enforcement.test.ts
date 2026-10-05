import { describe, expect, it, vi } from "vitest";
import { InMemoryCostBudgetProvider } from "../../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor } from "../../agent/lib/dark-factory/cost-governor";
import { runGovernedLlmCall } from "../../agent/lib/dark-factory/governed-llm-call";
import { createOrchestratorGate } from "../../agent/orchestrator-gate";

const PERIOD = "2026-10";
const MODEL = "deepseek/deepseek-chat";
const ENV = {
  DF_COST_BUDGET_PERIOD: PERIOD,
  DF_COST_BUDGET_ORCHESTRATOR_USD: "10",
  DF_COST_BUDGET_DEVELOPER_USD: "10",
  DF_COST_BUDGET_TESTER_USD: "10",
  DF_COST_BUDGET_PR_REVIEW_USD: "10",
};

async function storeWith(cap: number, tenant: string) {
  const store = new InMemoryCostBudgetProvider();
  await store.ensureBudget(PERIOD, "orchestrator", cap, tenant);
  await store.ensureBudget(PERIOD, "pr-review", cap, tenant);
  return store;
}

describe("tenant budget enforcement (#230)", () => {
  it("refuses with tenant_unconfigured when the tenant has no budget", async () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), ENV);
    const decision = await governor.admit({
      category: "orchestrator",
      model: MODEL,
      inputTokens: 1000,
      outputTokens: 1000,
      tenantId: "tenant-x",
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("tenant_unconfigured");
    expect(decision.tenantId).toBe("tenant-x");
  });

  it("names the tenant in the orchestrator gate refusal", async () => {
    const gate = createOrchestratorGate({
      env: ENV,
      model: MODEL,
      inputTokens: 1000,
      tenantId: "tenant-x",
      governor: createCostGovernor(new InMemoryCostBudgetProvider(), ENV),
    });
    expect(gate).not.toBeNull();
    await expect(gate!.admit()).rejects.toThrow(/tenant-x/);
  });

  it("admits and settles a governed call for a provisioned tenant", async () => {
    const store = await storeWith(10, "tenant-a");
    const governor = createCostGovernor(store, ENV);
    const outcome = await runGovernedLlmCall({
      governor,
      category: "pr-review",
      model: MODEL,
      inputTokens: 1000,
      outputTokens: 1000,
      tenantId: "tenant-a",
      run: async () => "reviewed",
      costOf: () => 0.001,
    });
    expect(outcome.ok).toBe(true);
    const rows = (await store.listTenantBudgets("tenant-a", PERIOD)).value;
    const budget = rows.find((row) => row.category === "pr-review");
    expect(budget?.spentUsd).toBeCloseTo(0.001);
    expect(budget?.callCount).toBe(1);
  });

  it("does not run the call when the tenant budget is exhausted", async () => {
    const store = await storeWith(0.0000001, "tenant-a");
    const governor = createCostGovernor(store, ENV);
    const run = vi.fn(async () => "should not run");
    const outcome = await runGovernedLlmCall({
      governor,
      category: "pr-review",
      model: MODEL,
      inputTokens: 1000,
      outputTokens: 1000,
      tenantId: "tenant-a",
      run,
    });
    expect(outcome.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the global path working when no tenant is given", async () => {
    const store = new InMemoryCostBudgetProvider();
    const governor = createCostGovernor(store, ENV);
    const outcome = await runGovernedLlmCall({
      governor,
      category: "pr-review",
      model: MODEL,
      inputTokens: 1000,
      outputTokens: 1000,
      run: async () => "global",
      costOf: () => 0.002,
    });
    expect(outcome.ok).toBe(true);
    const globals = await store.listBudgets(PERIOD);
    expect(globals.value).toHaveLength(1);
    expect(globals.value[0].tenantId).toBeUndefined();
    expect(globals.value[0].spentUsd).toBeCloseTo(0.002);
  });
});