import { describe, expect, it } from "vitest";
import {
  InMemoryCostBudgetProvider,
  createCostBudgetStore,
} from "../../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor, utcMonth } from "../../agent/lib/dark-factory/cost-governor";

const ENV: Record<string, string | undefined> = {
  DF_COST_BUDGET_ORCHESTRATOR_USD: "10",
  DF_COST_BUDGET_DEVELOPER_USD: "5",
  DF_COST_BUDGET_TESTER_USD: "5",
  DF_COST_BUDGET_PR_REVIEW_USD: "5",
};

const MODEL = "deepseek/deepseek-chat";

describe("cost governor", () => {
  it("admits a call under the cap and reserves its estimated cost", async () => {
    const store = new InMemoryCostBudgetProvider();
    const governor = createCostGovernor(store, ENV);

    const decision = await governor.admit({
      category: "orchestrator",
      model: MODEL,
      inputTokens: 1_000,
      outputTokens: 1_000,
    });

    expect(decision.admitted).toBe(true);
    expect(decision.reservationId).toBeTruthy();
    expect(decision.estimatedUsd).toBeGreaterThan(0);
    expect(decision.period).toBe(utcMonth());

    const [budget] = await governor.status();
    expect(budget.reservedUsd).toBeCloseTo(decision.estimatedUsd!, 10);
    expect(budget.spentUsd).toBe(0);
  });

  it("refuses an unpriced model rather than estimating it at zero", async () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), ENV);
    const decision = await governor.admit({
      category: "orchestrator",
      model: "unknown/model",
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("unpriced_model");
  });

  it("refuses a category with no configured cap", async () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), {
      DF_COST_BUDGET_ORCHESTRATOR_USD: "10",
    });
    const decision = await governor.admit({
      category: "tester",
      model: MODEL,
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("not_configured");
  });

  it("refuses when the budget store is unavailable", async () => {
    const governor = createCostGovernor(createCostBudgetStore({}), ENV);
    const decision = await governor.admit({
      category: "orchestrator",
      model: MODEL,
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("budget_unavailable");
  });

  it("refuses a call whose estimate would exceed the cap", async () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), ENV);
    const decision = await governor.admit({
      category: "pr-review",
      model: MODEL,
      // 100M output tokens * 0.0003/1k = 30 USD, well over the 5 USD cap.
      inputTokens: 0,
      outputTokens: 100_000_000,
    });
    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe("budget_exceeded");
  });

  it("never admits concurrent calls past the cap", async () => {
    const store = new InMemoryCostBudgetProvider();
    // Small cap so only a few concurrent reservations can fit.
    const governor = createCostGovernor(store, {
      ...ENV,
      DF_COST_BUDGET_ORCHESTRATOR_USD: "0.001",
    });

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        governor.admit({
          category: "orchestrator",
          model: MODEL,
          inputTokens: 1_000,
          outputTokens: 1_000,
        }),
      ),
    );
    const admitted = attempts.filter((decision) => decision.admitted);
    // Each estimate is 0.0004 USD; the 0.001 cap admits at most 2.
    expect(admitted.length).toBeLessThanOrEqual(2);
    expect(attempts.some((decision) => decision.reason === "budget_exceeded")).toBe(true);
  });

  it("records the actual cost on settle and releases the reservation", async () => {
    const store = new InMemoryCostBudgetProvider();
    const governor = createCostGovernor(store, ENV);

    const decision = await governor.admit({
      category: "developer",
      model: MODEL,
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    const settled = await governor.settle(decision.reservationId!, 0.25);
    expect(settled.ok).toBe(true);

    const [budget] = await governor.status();
    expect(budget.spentUsd).toBe(0.25);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.callCount).toBe(1);
  });

  it("charges the estimate when the provider reports no cost", async () => {
    const store = new InMemoryCostBudgetProvider();
    const governor = createCostGovernor(store, ENV);
    const decision = await governor.admit({
      category: "tester",
      model: MODEL,
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    await governor.settle(decision.reservationId!, null);

    const [budget] = await governor.status();
    expect(budget.spentUsd).toBeCloseTo(decision.estimatedUsd!, 10);
    expect(budget.callCount).toBe(1);
  });

  it("computes the period as UTC YYYY-MM and honours a concrete override", () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), ENV);
    expect(governor.period(new Date("2026-02-15T00:00:00.000Z"))).toBe("2026-02");

    const pinned = createCostGovernor(new InMemoryCostBudgetProvider(), {
      ...ENV,
      DF_COST_BUDGET_PERIOD: "2026-03",
    });
    expect(pinned.period(new Date("2026-02-15T00:00:00.000Z"))).toBe("2026-03");
  });
});