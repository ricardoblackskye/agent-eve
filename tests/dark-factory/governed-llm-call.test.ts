import { describe, expect, it, vi } from "vitest";
import { InMemoryCostBudgetProvider } from "../../agent/lib/dark-factory/cost-budget-store";
import { createCostGovernor } from "../../agent/lib/dark-factory/cost-governor";
import { runGovernedLlmCall } from "../../agent/lib/dark-factory/governed-llm-call";

const MODEL = "deepseek/deepseek-chat";
const ENV: Record<string, string | undefined> = {
  DF_COST_BUDGET_ORCHESTRATOR_USD: "10",
  DF_COST_BUDGET_PR_REVIEW_USD: "5",
  DF_COST_BUDGET_DEVELOPER_USD: "5",
  DF_COST_BUDGET_TESTER_USD: "5",
};

describe("runGovernedLlmCall", () => {
  it("runs the call when admitted and settles the measured cost", async () => {
    const store = new InMemoryCostBudgetProvider();
    const governor = createCostGovernor(store, ENV);
    const run = vi.fn(async () => ({ text: "hello", costUsd: 0.4 }));

    const outcome = await runGovernedLlmCall({
      governor,
      category: "orchestrator",
      model: MODEL,
      inputTokens: 1_000,
      outputTokens: 1_000,
      run,
      costOf: (result) => result.costUsd,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.text).toBe("hello");
    expect(run).toHaveBeenCalledTimes(1);

    const [budget] = await governor.status();
    expect(budget.spentUsd).toBe(0.4);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.callCount).toBe(1);
  });

  it("does NOT run the call when the governor refuses", async () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), ENV);
    const run = vi.fn().mockResolvedValue("should not run");

    const outcome = await runGovernedLlmCall({
      governor,
      category: "pr-review",
      model: MODEL,
      // Over the 5 USD cap.
      inputTokens: 0,
      outputTokens: 100_000_000,
      run,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("budget_exceeded");
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an unpriced model without running the call", async () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), ENV);
    const run = vi.fn();

    const outcome = await runGovernedLlmCall({
      governor,
      category: "orchestrator",
      model: "unknown/model",
      inputTokens: 1_000,
      outputTokens: 1_000,
      run,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("unpriced_model");
    expect(run).not.toHaveBeenCalled();
  });

  it("settles conservatively and rethrows when the call fails", async () => {
    const store = new InMemoryCostBudgetProvider();
    const governor = createCostGovernor(store, ENV);

    await expect(
      runGovernedLlmCall({
        governor,
        category: "developer",
        model: MODEL,
        inputTokens: 1_000,
        outputTokens: 1_000,
        run: async () => {
          throw new Error("provider exploded");
        },
      }),
    ).rejects.toThrow("provider exploded");

    // The reservation must not be leaked: it is charged at the estimate.
    const [budget] = await governor.status();
    expect(budget.reservedUsd).toBe(0);
    expect(budget.spentUsd).toBeGreaterThan(0);
    expect(budget.callCount).toBe(1);
  });
});