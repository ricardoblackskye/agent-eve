import { describe, expect, it } from "vitest";
import {
  CostCategory,
  isCostCategory,
  CostBudget,
  isCostBudget,
  createCostGovernanceEnv,
  validateCostBudgetEnv,
  CostBudgetEnvError,
  resolvePrice,
  estimateCost,
  modelPriceTable,
  applyPriceFloor,
} from "../../agent/lib/dark-factory/cost-budget";
import { observedDearest } from "../../agent/lib/dark-factory/model-price-floor";

describe("cost-budget canonical types and price table", () => {
  describe("CostCategory enum + isCostCategory", () => {
    it("accepts the five defined categories", () => {
      expect(isCostCategory("orchestrator")).toBe(true);
      expect(isCostCategory("developer")).toBe(true);
      expect(isCostCategory("tester")).toBe(true);
      expect(isCostCategory("pr-review")).toBe(true);
      // #484: architect planning is its own category, so its spend stops
      // being charged against the developer ceiling.
      expect(isCostCategory("architect")).toBe(true);
    });

    it("rejects unknown strings", () => {
      expect(isCostCategory("")).toBe(false);
      expect(isCostCategory("  ")).toBe(false);
      expect(isCostCategory("Orchestrator")).toBe(false);
      expect(isCostCategory("sandbox")).toBe(false);
      expect(isCostCategory("billing")).toBe(false);
    });
  });

  describe("CostBudget validation", () => {
    it("constructs valid per-process budgets", () => {
      const budget: CostBudget = {
        category: "orchestrator",
        period: "2026-02",
        capUsd: 50,
        spentUsd: 7.25,
        callCount: 3,
      };
      expect(budget.category).toBe("orchestrator");
      expect(budget.period).toBe("2026-02");
      expect(budget.capUsd).toBe(50);
      expect(budget.spentUsd).toBe(7.25);
      expect(budget.callCount).toBe(3);
    });

    it("isCostBudget rejects invalid shapes", () => {
      expect(isCostBudget(null as any)).toBe(false);
      expect(isCostBudget(undefined as any)).toBe(false);
      expect(isCostBudget({ category: "orchestrator" } as any)).toBe(false);
      expect(
        isCostBudget({ category: "orchestrator", period: "2026-02" } as any),
      ).toBe(false);
      expect(
        isCostBudget({ category: "orchestrator", period: "2026-02", capUsd: 50 } as any),
      ).toBe(false);
      expect(
        isCostBudget({
          category: "orchestrator",
          period: "2026-02",
          capUsd: 50,
          spentUsd: 7.25,
        } as any),
      ).toBe(false);
      expect(isCostBudget({ capUsd: 50 } as any)).toBe(false);

      // Valid shape must have string category + string period + non-negative numbers.
      expect(
        isCostBudget({
          category: "orchestrator",
          period: "2026-02",
          capUsd: 50,
          spentUsd: 7.25,
          callCount: 3,
        }),
      ).toBe(true);
      expect(
        isCostBudget({
          category: "pr-review",
          period: "2026-02",
          capUsd: 0,
          spentUsd: 0,
          callCount: 0,
        }),
      ).toBe(true);
      expect(
        isCostBudget({
          category: "developer",
          period: "2026-02",
          capUsd: 100,
          spentUsd: 100,
          callCount: 4,
        }),
      ).toBe(true);
    });

    it("isCostBudget rejects negative non-integer, negative call count, and empty strings", () => {
      expect(
        isCostBudget({
          category: "",
          period: "2026-02",
          capUsd: 50,
          spentUsd: 0,
          callCount: 0,
        }),
      ).toBe(false);
      expect(
        isCostBudget({
          category: "orchestrator",
          period: "",
          capUsd: 50,
          spentUsd: 0,
          callCount: 0,
        }),
      ).toBe(false);
      expect(
        isCostBudget({
          category: "orchestrator",
          period: "2026-02",
          capUsd: -1,
          spentUsd: 0,
          callCount: 0,
        }),
      ).toBe(false);
      expect(
        isCostBudget({
          category: "orchestrator",
          period: "2026-02",
          capUsd: 50,
          spentUsd: -0.01,
          callCount: 0,
        }),
      ).toBe(false);
      expect(
        isCostBudget({
          category: "orchestrator",
          period: "2026-02",
          capUsd: 50,
          spentUsd: 0,
          callCount: -1,
        }),
      ).toBe(false);
      expect(
        isCostBudget({
          category: "orchestrator",
          period: "2026-02",
          capUsd: 50,
          spentUsd: 7.25,
          callCount: 3.1,
        }),
      ).toBe(false);
    });
  });

  describe("env config to canonical budget mapping", () => {
    it("creates a resolved env with default period when unset", () => {
      const env = createCostGovernanceEnv({
        DF_COST_BUDGET_PERIOD: undefined,
        DF_COST_BUDGET_DATABASE_URL: undefined,
        DF_COST_BUDGET_DRIVER: undefined,
        DF_COST_BUDGET_DB_PATH: undefined,
        DF_COST_BUDGET_ORCHESTRATOR_USD: "50",
        DF_COST_BUDGET_DEVELOPER_USD: "100",
        DF_COST_BUDGET_TESTER_USD: "50",
        DF_COST_BUDGET_PR_REVIEW_USD: "25",
      });
      expect(env.period).toBe("YYYY-MM");
      expect(env.categories["orchestrator"]).toBe(50);
      expect(env.categories["developer"]).toBe(100);
      expect(env.categories["tester"]).toBe(50);
      expect(env.categories["pr-review"]).toBe(25);
    });

    it("parses a custom explicit period", () => {
      expect(
        createCostGovernanceEnv({
          DF_COST_BUDGET_PERIOD: "2026-02",
          DF_COST_BUDGET_DATABASE_URL: undefined,
          DF_COST_BUDGET_DRIVER: undefined,
          DF_COST_BUDGET_DB_PATH: undefined,
          DF_COST_BUDGET_ORCHESTRATOR_USD: "50",
          DF_COST_BUDGET_DEVELOPER_USD: "100",
          DF_COST_BUDGET_TESTER_USD: "50",
          DF_COST_BUDGET_PR_REVIEW_USD: "25",
        }).period,
      ).toBe("2026-02");
    });

    it("defaults period to YYYY-MM when a non-period value is set", () => {
      const env = createCostGovernanceEnv({
        DF_COST_BUDGET_PERIOD: "daily",
        DF_COST_BUDGET_DATABASE_URL: undefined,
        DF_COST_BUDGET_DRIVER: undefined,
        DF_COST_BUDGET_DB_PATH: undefined,
        DF_COST_BUDGET_ORCHESTRATOR_USD: "5",
        DF_COST_BUDGET_DEVELOPER_USD: "10",
        DF_COST_BUDGET_TESTER_USD: "5",
        DF_COST_BUDGET_PR_REVIEW_USD: "2",
      });
      expect(env.period).toBe("daily");
      expect(env.categories["orchestrator"]).toBe(5);
    });

    it("rejects a missing or non-numeric cap", () => {
      expect(() =>
        validateCostBudgetEnv({
          DF_COST_BUDGET_PERIOD: "2026-02",
          DF_COST_BUDGET_DATABASE_URL: undefined,
          DF_COST_BUDGET_DRIVER: undefined,
          DF_COST_BUDGET_DB_PATH: undefined,
          DF_COST_BUDGET_ORCHESTRATOR_USD: "",
          DF_COST_BUDGET_DEVELOPER_USD: "100",
          DF_COST_BUDGET_TESTER_USD: "50",
          DF_COST_BUDGET_PR_REVIEW_USD: "25",
        }),
      ).toThrow(CostBudgetEnvError);
      expect(() =>
        validateCostBudgetEnv({
          DF_COST_BUDGET_PERIOD: "2026-02",
          DF_COST_BUDGET_DATABASE_URL: undefined,
          DF_COST_BUDGET_DRIVER: undefined,
          DF_COST_BUDGET_DB_PATH: undefined,
          DF_COST_BUDGET_ORCHESTRATOR_USD: "abc",
          DF_COST_BUDGET_DEVELOPER_USD: "100",
          DF_COST_BUDGET_TESTER_USD: "50",
          DF_COST_BUDGET_PR_REVIEW_USD: "25",
        }),
      ).toThrow(CostBudgetEnvError);
      expect(() =>
        validateCostBudgetEnv({
          DF_COST_BUDGET_PERIOD: "2026-02",
          DF_COST_BUDGET_DATABASE_URL: undefined,
          DF_COST_BUDGET_DRIVER: undefined,
          DF_COST_BUDGET_DB_PATH: undefined,
          DF_COST_BUDGET_ORCHESTRATOR_USD: "-5",
          DF_COST_BUDGET_DEVELOPER_USD: "100",
          DF_COST_BUDGET_TESTER_USD: "50",
          DF_COST_BUDGET_PR_REVIEW_USD: "25",
        }),
      ).toThrow(CostBudgetEnvError);
    });

    it("accepts zero cap but rejects negative", () => {
      expect(() =>
        validateCostBudgetEnv({
          DF_COST_BUDGET_PERIOD: "2026-02",
          DF_COST_BUDGET_DATABASE_URL: undefined,
          DF_COST_BUDGET_DRIVER: undefined,
          DF_COST_BUDGET_DB_PATH: undefined,
          DF_COST_BUDGET_ORCHESTRATOR_USD: "0",
          DF_COST_BUDGET_DEVELOPER_USD: "100",
          DF_COST_BUDGET_TESTER_USD: "50",
          DF_COST_BUDGET_PR_REVIEW_USD: "25",
        }),
      ).not.toThrow();
    });

    it("ignores extra env keys and only validates required ones", () => {
      const env = createCostGovernanceEnv({
        DF_COST_BUDGET_PERIOD: "2026-02",
        DF_COST_BUDGET_DATABASE_URL: undefined,
        DF_COST_BUDGET_DRIVER: undefined,
        DF_COST_BUDGET_DB_PATH: undefined,
        DF_COST_BUDGET_ORCHESTRATOR_USD: "50",
        DF_COST_BUDGET_DEVELOPER_USD: "100",
        DF_COST_BUDGET_TESTER_USD: "50",
        DF_COST_BUDGET_PR_REVIEW_USD: "25",
        SOME_RANDOM_VAR: "whatever",
      });
      expect(env.period).toBe("2026-02");
      expect(env.categories["orchestrator"]).toBe(50);
    });

    // #484: the architect category must be resolvable WITHOUT a new required env var,
    // or every existing deployment fails to start (validateCostBudgetEnv is fail-closed).
    describe("architect category (#484)", () => {
      const base = {
        DF_COST_BUDGET_PERIOD: "2026-02",
        DF_COST_BUDGET_DATABASE_URL: undefined,
        DF_COST_BUDGET_DRIVER: undefined,
        DF_COST_BUDGET_DB_PATH: undefined,
        DF_COST_BUDGET_ORCHESTRATOR_USD: "50",
        DF_COST_BUDGET_DEVELOPER_USD: "100",
        DF_COST_BUDGET_TESTER_USD: "50",
        DF_COST_BUDGET_PR_REVIEW_USD: "25",
      };

      it("uses DF_COST_BUDGET_ARCHITECT_USD when it is set", () => {
        const env = createCostGovernanceEnv({
          ...base,
          DF_COST_BUDGET_ARCHITECT_USD: "30",
        });
        expect(env.categories["architect"]).toBe(30);
      });

      it("defaults the architect cap to the orchestrator cap when unset", () => {
        const env = createCostGovernanceEnv({ ...base });
        expect(env.categories["architect"]).toBe(50);
        expect(env.categories["architect"]).toBe(env.categories["orchestrator"]);
      });

      it("does not throw when the architect cap is unset", () => {
        expect(() => validateCostBudgetEnv({ ...base })).not.toThrow();
      });

      it("still rejects a negative architect cap", () => {
        expect(() =>
          validateCostBudgetEnv({ ...base, DF_COST_BUDGET_ARCHITECT_USD: "-5" }),
        ).toThrow(CostBudgetEnvError);
      });
    });
  });

  describe("model price table", () => {
    it("resolves known model ids to sane per-1k-token prices", () => {
      const deepseek = resolvePrice("deepseek/deepseek-chat");
      expect(deepseek).not.toBeNull();
      const price = deepseek!;
      expect(price.inputUsdPer1k + price.outputUsdPer1k).toBeGreaterThan(0);
    });

    it("returns null for unknown models", () => {
      expect(resolvePrice("unknown/model")).toBeNull();
      expect(resolvePrice("")).toBeNull();
      expect(resolvePrice("  ")).toBeNull();
      expect(resolvePrice(null as any)).toBeNull();
    });

    it("estimateCost computes approximate USD from tokens + model price", () => {
      const price = resolvePrice("deepseek/deepseek-chat");
      expect(price).not.toBeNull();
      const cost = estimateCost("deepseek/deepseek-chat", 1000, 200);
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(0.01);
    });

    it("estimateCost returns 0 when no price is known but does not throw", () => {
      expect(
        estimateCost("unknown/model", 1000000, 500000),
      ).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("#498 the reserved price covers the observed dearest floor", () => {
  const table = { inputUsdPer1k: 0.0006, outputUsdPer1k: 0.0024 };
  const floor = { inputUsdPer1k: 0.0006, outputUsdPer1k: 0.006727487, providers: 41 };

  it("raises a table entry that has fallen below the dearest observed rate", () => {
    expect(applyPriceFloor(table, floor)).toEqual({
      inputUsdPer1k: 0.0006,
      outputUsdPer1k: 0.006727487,
    });
  });

  it("keeps the axes independent - a high input floor must not drag output up", () => {
    const raised = applyPriceFloor(
      { inputUsdPer1k: 1, outputUsdPer1k: 1 },
      { inputUsdPer1k: 5, outputUsdPer1k: 0.5, providers: 2 },
    );
    expect(raised).toEqual({ inputUsdPer1k: 5, outputUsdPer1k: 1 });
  });

  it("never returns less than the table - the floor only ever raises", () => {
    expect(
      applyPriceFloor(
        { inputUsdPer1k: 9, outputUsdPer1k: 9 },
        { inputUsdPer1k: 1, outputUsdPer1k: 1, providers: 1 },
      ),
    ).toEqual({ inputUsdPer1k: 9, outputUsdPer1k: 9 });
  });

  it("returns the table unchanged when the model has no recorded floor", () => {
    expect(applyPriceFloor(table, undefined)).toEqual(table);
  });

  it("covers the floor for every recorded model through resolvePrice", () => {
    const ids = Object.keys(observedDearest);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    for (const id of ids) {
      const observed = observedDearest[id];
      const resolved = resolvePrice(id);
      expect(resolved, `${id} has no price`).not.toBeNull();
      expect(
        resolved?.inputUsdPer1k,
        `${id}: reserved input ${resolved?.inputUsdPer1k} is below the observed floor ${observed.inputUsdPer1k}`,
      ).toBeGreaterThanOrEqual(observed.inputUsdPer1k);
      expect(
        resolved?.outputUsdPer1k,
        `${id}: reserved output ${resolved?.outputUsdPer1k} is below the observed floor ${observed.outputUsdPer1k}`,
      ).toBeGreaterThanOrEqual(observed.outputUsdPer1k);
    }
  });

  it("reserves exactly max(table, floor) - not more than it must", () => {
    for (const [id, observed] of Object.entries(observedDearest)) {
      const entry = modelPriceTable[id];
      if (!entry) continue;
      expect(resolvePrice(id), `${id}`).toEqual({
        inputUsdPer1k: Math.max(entry.inputUsdPer1k, observed.inputUsdPer1k),
        outputUsdPer1k: Math.max(entry.outputUsdPer1k, observed.outputUsdPer1k),
      });
    }
  });
});
