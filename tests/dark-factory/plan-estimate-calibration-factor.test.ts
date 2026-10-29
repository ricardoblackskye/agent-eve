import { describe, expect, it } from "vitest";
import {
  classifyCost,
  decomposePlanCostEstimate,
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

function plan(): ExecutionPlan {
  return {
    storyId: 490,
    title: "calibration report",
    summary: "the loop closes",
    targetFiles: files(6),
    tasks: [
      { title: "one", objective: "structural fixture" },
      { title: "two", objective: "structural fixture" },
    ],
    acceptanceCriteriaMap: [],
  };
}

describe("plan-estimate calibration factor (#490)", () => {
  it("defaults to 1 — omitting the factor leaves the band byte-identical", () => {
    const omitted = estimatePlanCost({ plan: plan(), model: MODEL });
    const explicitOne = estimatePlanCost({ plan: plan(), model: MODEL, calibrationFactor: 1 });
    expect(JSON.stringify(explicitOne)).toBe(JSON.stringify(omitted));
  });

  it("scales the expectation and both band edges by the factor", () => {
    const base = estimatePlanCost({ plan: plan(), model: MODEL });
    const halved = estimatePlanCost({ plan: plan(), model: MODEL, calibrationFactor: 0.5 });

    expect(halved.expectedUsd).toBeCloseTo(base.expectedUsd * 0.5, 10);
    expect(halved.lowUsd).toBeCloseTo(base.lowUsd * 0.5, 10);
    expect(halved.highUsd).toBeCloseTo(base.highUsd * 0.5, 10);
    // Derived, not assumed: halving CAN cross an edge, so the class must follow the scaled band.
    expect(halved.costClass).toBe(classifyCost(halved.expectedUsd));
  });

  it("re-classifies a band pushed across a cost-class edge", () => {
    const base = estimatePlanCost({ plan: plan(), model: MODEL });
    const scaledUp = estimatePlanCost({ plan: plan(), model: MODEL, calibrationFactor: 20 });

    expect(scaledUp.costClass).toBe(classifyCost(base.expectedUsd * 20));
    expect(scaledUp.costClass).not.toBe(base.costClass);
  });

  it("records the APPLIED factor, so a persisted band stays auditable", () => {
    expect(
      estimatePlanCost({ plan: plan(), model: MODEL, calibrationFactor: 0.5 }).features
        .calibrationFactor,
    ).toBe(0.5);
    expect(estimatePlanCost({ plan: plan(), model: MODEL }).features.calibrationFactor).toBe(1);
  });

  it("scales the stage decomposition identically, so its parts still sum to the band", () => {
    // Compared against the SCALED band, not against another unfactored call: comparing two things
    // that both ignore the factor would pass without the factor being applied at all.
    const base = estimatePlanCost({ plan: plan(), model: MODEL });
    const parts = decomposePlanCostEstimate({
      plan: plan(),
      model: MODEL,
      calibrationFactor: 0.5,
    });
    const sum = parts.reduce((total, entry) => total + entry.expectedUsd, 0);
    expect(sum).toBeCloseTo(base.expectedUsd * 0.5, 10);
  });

  it("ignores a non-finite or non-positive factor rather than emitting a NaN band", () => {
    const base = estimatePlanCost({ plan: plan(), model: MODEL });
    for (const bad of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const got = estimatePlanCost({ plan: plan(), model: MODEL, calibrationFactor: bad });
      expect(Number.isFinite(got.expectedUsd)).toBe(true);
      expect(got.expectedUsd).toBeCloseTo(base.expectedUsd, 10);
      expect(got.features.calibrationFactor).toBe(1);
    }
  });
});
