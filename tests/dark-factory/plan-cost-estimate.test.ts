import { describe, expect, it } from "vitest";
import {
  BAND_HIGH_MULTIPLIER,
  BAND_LOW_MULTIPLIER,
  classifyCost,
  estimatePlanCost,
} from "../../agent/lib/dark-factory/plan-cost-estimate";
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
});
