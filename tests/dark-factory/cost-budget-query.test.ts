import { describe, expect, it } from "vitest";
import { InMemoryCostBudgetProvider } from "../../agent/lib/dark-factory/cost-budget-store";
import { ConsoleCostBudgetProvider } from "../../agent/lib/dark-factory/cost-budget-store";
import { queryCostBudgets } from "../../agent/lib/dark-factory/cost-budget-query";

const PERIOD = "2026-02";

describe("queryCostBudgets", () => {
  it("rejects a malformed period with a 400", async () => {
    const outcome = await queryCostBudgets(new InMemoryCostBudgetProvider(), {
      period: "February",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(400);
  });

  it("returns 503 when the budget store refuses", async () => {
    const outcome = await queryCostBudgets(new ConsoleCostBudgetProvider(), {});
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.status).toBe(503);
  });

  it("renders every canonical category, with null for an unconfigured one", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "orchestrator", 10);

    const outcome = await queryCostBudgets(store, { period: PERIOD });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(outcome.report.budgets).toHaveLength(4);
    const byCategory = new Map(
      outcome.report.budgets.map((view, index) => [index, view]),
    );
    // orchestrator is index 0 and configured; the rest are gaps.
    expect(byCategory.get(0)).not.toBeNull();
    expect(byCategory.get(0)!.capUsd).toBe(10);
    expect(byCategory.get(1)).toBeNull();
    expect(byCategory.get(2)).toBeNull();
    expect(byCategory.get(3)).toBeNull();
  });

  it("computes remaining and totals across categories", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "orchestrator", 10);
    await store.ensureBudget(PERIOD, "developer", 4);
    const reserved = await store.reserve(PERIOD, "orchestrator", 3);
    await store.settle(reserved.reservationId!, 2);

    const outcome = await queryCostBudgets(store, { period: PERIOD });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const orchestrator = outcome.report.budgets[0]!;
    expect(orchestrator.spentUsd).toBe(2);
    expect(orchestrator.reservedUsd).toBe(0);
    expect(orchestrator.remainingUsd).toBe(8);
    expect(orchestrator.callCount).toBe(1);

    expect(outcome.report.totals.capUsd).toBe(14);
    expect(outcome.report.totals.spentUsd).toBe(2);
    expect(outcome.report.totals.remainingUsd).toBe(12);
    expect(outcome.report.totals.callCount).toBe(1);
  });
});