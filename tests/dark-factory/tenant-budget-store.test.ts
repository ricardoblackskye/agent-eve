import { describe, expect, it } from "vitest";
import {
  InMemoryCostBudgetProvider,
  costBudgetId,
} from "../../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor } from "../../agent/lib/dark-factory/cost-governor";

const PERIOD = "2026-10";
const CATEGORY = "orchestrator" as const;

/** A store seeded with a per-tenant cap for two tenants. */
async function seeded(cap = 10): Promise<InMemoryCostBudgetProvider> {
  const store = new InMemoryCostBudgetProvider();
  await store.ensureBudget(PERIOD, CATEGORY, cap, "tenant-a");
  await store.ensureBudget(PERIOD, CATEGORY, cap, "tenant-b");
  return store;
}

describe("tenant-scoped cost budgets (#229)", () => {
  it("gives a tenant budget a distinct id from the global one", () => {
    expect(costBudgetId(PERIOD, CATEGORY)).not.toBe(
      costBudgetId(PERIOD, CATEGORY, "tenant-a"),
    );
  });

  it("keeps tenants isolated", async () => {
    const store = await seeded(10);
    expect((await store.reserve(PERIOD, CATEGORY, 6, "tenant-a")).ok).toBe(true);
    // tenant-b still has its whole cap available
    expect((await store.reserve(PERIOD, CATEGORY, 6, "tenant-b")).ok).toBe(true);
  });

  it("trips exactly at the cap boundary", async () => {
    const store = await seeded(10);
    expect((await store.reserve(PERIOD, CATEGORY, 9, "tenant-a")).ok).toBe(true);
    // committed == cap must still be admitted
    expect((await store.reserve(PERIOD, CATEGORY, 1, "tenant-a")).ok).toBe(true);
    // anything above the cap must be refused
    const over = await store.reserve(PERIOD, CATEGORY, 0.01, "tenant-a");
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/exceed/i);
  });

  it("cannot be oversubscribed by simultaneous reservations", async () => {
    const store = await seeded(10);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.reserve(PERIOD, CATEGORY, 2, "tenant-a"),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(5); // 5 x 2 == the cap
  });

  it("settles idempotently — a duplicate settle does not double-charge", async () => {
    const store = await seeded(10);
    const reserved = await store.reserve(PERIOD, CATEGORY, 4, "tenant-a");
    await store.settle(reserved.reservationId!, 3);
    await store.settle(reserved.reservationId!, 3);
    const [budget] = (await store.listTenantBudgets("tenant-a", PERIOD)).value;
    expect(budget.spentUsd).toBe(3);
    expect(budget.callCount).toBe(1);
    expect(budget.reservedUsd).toBe(0);
  });

  it("retains a conservative charge when the actual cost is unmeasured", async () => {
    const store = await seeded(10);
    const reserved = await store.reserve(PERIOD, CATEGORY, 4, "tenant-a");
    await store.settle(reserved.reservationId!, null);
    const [budget] = (await store.listTenantBudgets("tenant-a", PERIOD)).value;
    // never zero, never released as though the call were free
    expect(budget.spentUsd).toBe(4);
  });

  it("refuses a tenant reservation when no tenant budget exists (fail closed)", async () => {
    const store = new InMemoryCostBudgetProvider();
    const refused = await store.reserve(PERIOD, CATEGORY, 1, "tenant-unknown");
    expect(refused.ok).toBe(false);
  });

  it("leaves the global (tenant-less) path unchanged", async () => {
    const store = await seeded(10);
    await store.ensureBudget(PERIOD, CATEGORY, 5);

    const globals = await store.listBudgets(PERIOD);
    expect(globals.value).toHaveLength(1);
    expect(globals.value[0].tenantId).toBeUndefined();

    expect((await store.reserve(PERIOD, CATEGORY, 5)).ok).toBe(true);
    // the global reserve must not touch either tenant's budget
    const [a] = (await store.listTenantBudgets("tenant-a", PERIOD)).value;
    expect(a.reservedUsd).toBe(0);
  });
});

describe("cost governor — tenant scope (#229)", () => {
  const ENV = {
    DF_COST_BUDGET_PERIOD: PERIOD,
    DF_COST_BUDGET_ORCHESTRATOR_USD: "10",
    DF_COST_BUDGET_DEVELOPER_USD: "10",
    DF_COST_BUDGET_TESTER_USD: "10",
    DF_COST_BUDGET_PR_REVIEW_USD: "10",
  };

  it("admits against the tenant's own budget", async () => {
    const store = await seeded(10);
    const governor = createCostGovernor(store, ENV);
    const decision = await governor.admit({
      category: CATEGORY,
      model: "deepseek/deepseek-chat",
      inputTokens: 1000,
      outputTokens: 1000,
      tenantId: "tenant-a",
    });
    expect(decision.admitted).toBe(true);
    expect(decision.reservationId).toBeTruthy();
  });

  it("refuses when the tenant has no configured budget", async () => {
    const store = new InMemoryCostBudgetProvider();
    const governor = createCostGovernor(store, ENV);
    const decision = await governor.admit({
      category: CATEGORY,
      model: "deepseek/deepseek-chat",
      inputTokens: 1000,
      outputTokens: 1000,
      tenantId: "tenant-unknown",
    });
    expect(decision.admitted).toBe(false);
  });
});