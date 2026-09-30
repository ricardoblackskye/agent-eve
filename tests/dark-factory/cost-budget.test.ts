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
} from "../../agent/lib/dark-factory/cost-budget";

describe("cost-budget canonical types and price table", () => {
  describe("CostCategory enum + isCostCategory", () => {
    it("accepts the four defined categories", () => {
      expect(isCostCategory("orchestrator")).toBe(true);
      expect(isCostCategory("developer")).toBe(true);
      expect(isCostCategory("tester")).toBe(true);
      expect(isCostCategory("pr-review")).toBe(true);
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
