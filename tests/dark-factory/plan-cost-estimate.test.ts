import { describe, expect, it } from "vitest";
import {
  BAND_HIGH_MULTIPLIER,
  BAND_LOW_MULTIPLIER,
  classifyCost,
  estimatePlanCost,
} from "../../agent/lib/dark-factory/plan-cost-estimate";
import { modelPriceTable, resolvePrice } from "../../agent/lib/dark-factory/cost-budget";
import type { ExecutionPlan, PlanTargetFile } from "../../agent/lib/dark-factory/plan-validator";

const MODEL = "deepseek/deepseek-v4.1-flash";

function files(count: number): PlanTargetFile[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `file-${i}.ts`,
    action: "modify" as const,
    rationale: "structural fixture",
  }));
}

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    storyId: 485,
    title: "cost estimate",
    summary: "a story",
    targetFiles: files(2),
    acceptanceCriteriaMap: [],
    ...overrides,
  };
}

describe("plan-cost-estimate (#485)", () => {
  describe("structural band — cold start", () => {
    it("returns an ordered band whose edges follow the multipliers", () => {
      const estimate = estimatePlanCost({ plan: plan(), model: MODEL, history: [] });

      expect(estimate.lowUsd).toBeGreaterThan(0);
      expect(estimate.lowUsd).toBeLessThan(estimate.expectedUsd);
      expect(estimate.expectedUsd).toBeLessThan(estimate.highUsd);
      expect(estimate.lowUsd).toBeCloseTo(estimate.expectedUsd * BAND_LOW_MULTIPLIER, 10);
      expect(estimate.highUsd).toBeCloseTo(estimate.expectedUsd * BAND_HIGH_MULTIPLIER, 10);
    });

    it("marks a no-history estimate low confidence rather than refusing", () => {
      const estimate = estimatePlanCost({ plan: plan(), model: MODEL, history: [] });
      expect(estimate.confidence).toBe("low");
    });

    it("is deterministic — the same input yields a byte-identical estimate", () => {
      const first = estimatePlanCost({ plan: plan(), model: MODEL, history: [] });
      const second = estimatePlanCost({ plan: plan(), model: MODEL, history: [] });
      expect(first).toEqual(second);
    });

    it("prices more planned work higher than less", () => {
      const small = estimatePlanCost({ plan: plan({ targetFiles: files(1) }), model: MODEL, history: [] });
      const large = estimatePlanCost({ plan: plan({ targetFiles: files(20) }), model: MODEL, history: [] });

      expect(large.expectedUsd).toBeGreaterThan(small.expectedUsd);
      expect(large.highUsd).toBeGreaterThan(small.lowUsd);
    });

    it("reports the structural feature vector", () => {
      const estimate = estimatePlanCost({ plan: plan(), model: MODEL, history: [] });

      expect(estimate.features.targetFileCount).toBe(2);
      expect(typeof estimate.features.inputTokens).toBe("number");
      expect(typeof estimate.features.outputTokens).toBe("number");
    });
  });

  describe("cost class thresholds", () => {
    it("lands a value exactly on an edge in the UPPER class", () => {
      expect(classifyCost(0.25)).toBe("S");
      expect(classifyCost(1)).toBe("M");
      expect(classifyCost(5)).toBe("L");
      expect(classifyCost(20)).toBe("XL");
    });

    it("lands a value just below an edge in the lower class", () => {
      expect(classifyCost(0.2499)).toBe("XS");
      expect(classifyCost(0.9999)).toBe("S");
      expect(classifyCost(4.9999)).toBe("M");
      expect(classifyCost(19.9999)).toBe("L");
    });

    it("covers both open ends", () => {
      expect(classifyCost(0)).toBe("XS");
      expect(classifyCost(20.0001)).toBe("XL");
    });

    it("classifies the returned estimate the same way", () => {
      const estimate = estimatePlanCost({ plan: plan(), model: MODEL, history: [] });
      expect(estimate.costClass).toBe(classifyCost(estimate.expectedUsd));
    });
  });
  describe("price source — one source of truth", () => {
    it("prices a known model from the governor's own table", () => {
      const estimate = estimatePlanCost({ plan: plan(), model: MODEL, history: [] });
      const price = resolvePrice(MODEL)!;
      const inputTokens = estimate.features.inputTokens as number;
      const outputTokens = estimate.features.outputTokens as number;

      expect(estimate.expectedUsd).toBeCloseTo(
        (inputTokens / 1000) * price.inputUsdPer1k + (outputTokens / 1000) * price.outputUsdPer1k,
        10,
      );
      expect(estimate.features.priceSource).toBe("known-model");
    });

    it("moves the band when the injected price changes", () => {
      const cheap = estimatePlanCost({
        plan: plan(),
        model: MODEL,
        history: [],
        resolvePrice: () => ({ inputUsdPer1k: 1, outputUsdPer1k: 1 }),
      });
      const dear = estimatePlanCost({
        plan: plan(),
        model: MODEL,
        history: [],
        resolvePrice: () => ({ inputUsdPer1k: 10, outputUsdPer1k: 10 }),
      });

      // Ten times the rate is ten times the estimate — proves the seam is the price source.
      expect(dear.expectedUsd).toBeCloseTo(cheap.expectedUsd * 10, 10);
    });

    it("falls back to the dearest table rate for an unknown model, never zero", () => {
      const unknown = estimatePlanCost({ plan: plan(), model: "unknown/model", history: [] });
      const rates = Object.values(modelPriceTable);
      const dearestInput = Math.max(...rates.map((r) => r.inputUsdPer1k));
      const dearestOutput = Math.max(...rates.map((r) => r.outputUsdPer1k));

      // Zero would understate cost, which is the failure that matters.
      expect(unknown.expectedUsd).toBeGreaterThan(0);
      expect(unknown.features.priceInputUsdPer1k).toBe(dearestInput);
      expect(unknown.features.priceOutputUsdPer1k).toBe(dearestOutput);
      expect(unknown.features.priceSource).toBe("unknown-model-ceiling");
      expect(unknown.confidence).toBe("low");
    });

    it("costs an unknown model at least as much as the cheapest known one", () => {
      const unknown = estimatePlanCost({ plan: plan(), model: "unknown/model", history: [] });
      const cheapest = estimatePlanCost({ plan: plan(), model: "deepseek/deepseek-chat", history: [] });
      expect(unknown.expectedUsd).toBeGreaterThan(cheapest.expectedUsd);
    });
  });
});