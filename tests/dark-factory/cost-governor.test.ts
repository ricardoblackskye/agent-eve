import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCostBudgetProvider,
  createCostBudgetStore,
} from "../../agent/lib/dark-factory/cost-budget-store";
import { estimateCost } from "../../agent/lib/dark-factory/cost-budget";
import {
  REAP_INTERVAL_MS,
  RESERVATION_TTL_MS,
  createCostGovernor,
  utcMonth,
} from "../../agent/lib/dark-factory/cost-governor";

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

  it("#498 still refuses a model that only RESEMBLES a shipped one", async () => {
    // The floor must not become a looser price resolver: a near-miss id has no observation and no
    // ceiling, so it must refuse exactly as before, not be priced off a neighbouring entry.
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), ENV);
    for (const model of [
      "deepseek/deepseek-v4.1-flash-2",
      "deepseek/deepseek-v4.1",
      "deepseek/deepseek-v4.1-flash-mini",
    ]) {
      const decision = await governor.admit({
        category: "orchestrator",
        model,
        inputTokens: 1_000,
        outputTokens: 1_000,
      });
      expect(decision.admitted, model).toBe(false);
      expect(decision.reason, model).toBe("unpriced_model");
    }
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


/**
 * #457 - the reaper has to be SCHEDULED, not merely available.
 *
 * ADR 0054 shipped reapStaleReservations as the backstop for a reservation no JS can settle: a
 * killed process, a deployment swap, a platform timeout. Nothing called it, so 27 reservations
 * worth 42% of the production ceiling sat unreleased and every turn was refused. These tests pin
 * the schedule: reap on the admission path, at most once per interval, and never a hard
 * dependency of the call it protects.
 */
describe("scheduling the reaper (#457)", () => {
  /** One orchestrator call's estimate, read from the pricing table the governor uses. */
  const ONE_CALL = estimateCost(MODEL, 1_000, 1_000);

  /** A cap that fits ONE call: a second one needs the stale reserve released first. */
  const TIGHT = { DF_COST_BUDGET_ORCHESTRATOR_USD: String(ONE_CALL * 1.5) };
  /** Room for many calls, so an assertion is never about a refusal. */
  const ROOMY = { DF_COST_BUDGET_ORCHESTRATOR_USD: String(ONE_CALL * 100) };

  const admit = (governor: ReturnType<typeof createCostGovernor>) =>
    governor.admit({
      category: "orchestrator",
      model: MODEL,
      inputTokens: 1_000,
      outputTokens: 1_000,
    });

  it("releases a stale reservation on the next admission, which is then admitted", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryCostBudgetProvider();
      const governor = createCostGovernor(store, TIGHT);

      expect((await admit(governor)).admitted).toBe(true);

      // The process that took it is gone: nothing settles it, and its TTL passes.
      vi.advanceTimersByTime(RESERVATION_TTL_MS + 1);

      const second = await admit(governor);

      // Without the reap the stale reserve is still committed, so the cap refuses this call.
      expect(second.admitted).toBe(true);
      expect(second.reason).toBeUndefined();

      const [budget] = await governor.status();
      // Only the second reservation remains.
      expect(budget!.reservedUsd).toBeCloseTo(ONE_CALL, 10);
      // The stranded attempt stays visible even though it consumed nothing.
      expect(budget!.callCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not release a reservation younger than the TTL, and hands the TTL to the store", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryCostBudgetProvider();
      const reap = vi.spyOn(store, "reapStaleReservations");
      const governor = createCostGovernor(store, ROOMY);

      await admit(governor);
      // Past the interval (so the throttle permits a second pass) but inside the TTL: this
      // reservation is LIVE, and releasing it would let a slow turn overspend.
      vi.advanceTimersByTime(REAP_INTERVAL_MS + 1);
      await admit(governor);

      expect(reap).toHaveBeenCalledTimes(2);
      expect(reap).toHaveBeenLastCalledWith(RESERVATION_TTL_MS);
      const [budget] = await governor.status();
      expect(budget!.reservedUsd).toBeCloseTo(ONE_CALL * 2, 10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaps at most once per interval", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryCostBudgetProvider();
      const reap = vi.spyOn(store, "reapStaleReservations");
      const governor = createCostGovernor(store, ROOMY);

      // A fresh process reaps on its first admission: that is the serverless cold-start schedule.
      await admit(governor);
      expect(reap).toHaveBeenCalledTimes(1);

      // Inside the interval: no second store round trip for a turn of the same process.
      await admit(governor);
      expect(reap).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(REAP_INTERVAL_MS);
      await admit(governor);
      expect(reap).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits the call even when the reaper itself throws", async () => {
    const store = new InMemoryCostBudgetProvider();
    const reap = vi
      .spyOn(store, "reapStaleReservations")
      .mockRejectedValue(new Error("store unreachable"));
    const governor = createCostGovernor(store, ROOMY);

    const decision = await admit(governor);

    // Attempted (so this case is not vacuous) AND absorbed: a backstop must never veto the
    // call it exists to protect, and the store's own refusal path still reports itself.
    expect(reap).toHaveBeenCalledTimes(1);
    expect(decision.admitted).toBe(true);
  });

  it("charges architect spend to its own row, never the developer ceiling (#484)", async () => {
    const store = new InMemoryCostBudgetProvider();
    const governor = createCostGovernor(store, ENV);

    const arch = await governor.admit({
      category: "architect",
      model: MODEL,
      inputTokens: 1_000,
      outputTokens: 1_000,
    });
    expect(arch.admitted).toBe(true);
    const settled = await governor.settle(arch.reservationId!, 1);
    expect(settled.ok).toBe(true);

    const budgets = await governor.status();
    const architectRow = budgets.find((b) => b.category === "architect");
    const developerRow = budgets.find((b) => b.category === "developer");

    // The architect's dollar landed on its own row...
    expect(architectRow?.spentUsd).toBeCloseTo(1, 10);
    // ...and the developer ceiling is untouched, which is the whole point of #484.
    expect(developerRow?.spentUsd ?? 0).toBe(0);
  });

  it("defaults the architect cap to the orchestrator cap so an unconfigured deploy still admits (#484)", async () => {
    const governor = createCostGovernor(new InMemoryCostBudgetProvider(), {
      DF_COST_BUDGET_ORCHESTRATOR_USD: "10",
      DF_COST_BUDGET_DEVELOPER_USD: "5",
      DF_COST_BUDGET_TESTER_USD: "5",
      DF_COST_BUDGET_PR_REVIEW_USD: "5",
      // DF_COST_BUDGET_ARCHITECT_USD deliberately absent.
    });

    const decision = await governor.admit({
      category: "architect",
      model: MODEL,
      inputTokens: 1_000,
      outputTokens: 1_000,
    });

    // Not "not_configured": the default keeps planning possible without a new required env var.
    expect(decision.admitted).toBe(true);
    expect(decision.reason).not.toBe("not_configured");
  });
});
