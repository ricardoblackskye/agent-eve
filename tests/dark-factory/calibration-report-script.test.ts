import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decomposePlanCostEstimate,
  decomposePlanCostEstimateFromCounts,
  estimatePlanCost,
} from "../../agent/lib/dark-factory/plan-cost-estimate";
import {
  DEFAULT_MINIMUM_SAMPLE_SIZE,
  MINIMUM_SAMPLE_SIZE_ENV,
  resolveMinimumSampleSize,
} from "../../agent/lib/dark-factory/calibration-report";
import type { ExecutionPlan, PlanTargetFile, PlanTask } from "../../agent/lib/dark-factory/plan-validator";

const MODEL = "deepseek/deepseek-v4.1-flash";
const SCRIPT = readFileSync(resolve(process.cwd(), "scripts/df-calibration-report.ts"), "utf8");

function plan(fileCount: number, taskCount: number): ExecutionPlan {
  return {
    storyId: 490,
    title: "calibration report",
    summary: "the loop closes",
    targetFiles: Array.from({ length: fileCount }, (_, i) => ({
      path: `file-${i}.ts`,
      action: "modify" as const,
      rationale: "structural fixture",
    })) as PlanTargetFile[],
    tasks: Array.from({ length: taskCount }, (_, i) => ({
      title: `task ${i}`,
      objective: "structural fixture",
    })) as PlanTask[],
    acceptanceCriteriaMap: [],
  };
}

describe("the counts-only stage split (#490)", () => {
  it("is byte-identical to the plan-based split, since persistence keeps only counts", () => {
    const fromPlan = decomposePlanCostEstimate({ plan: plan(6, 3), model: MODEL });
    const fromCounts = decomposePlanCostEstimateFromCounts({
      targetFileCount: 6,
      taskCount: 3,
      model: MODEL,
    });
    expect(JSON.stringify(fromCounts)).toBe(JSON.stringify(fromPlan));
  });

  it("sums to the band it is reporting against", () => {
    const band = estimatePlanCost({ plan: plan(6, 3), model: MODEL });
    const sum = decomposePlanCostEstimateFromCounts({
      targetFileCount: 6,
      taskCount: 3,
      model: MODEL,
    }).reduce((total, entry) => total + entry.expectedUsd, 0);
    expect(sum).toBeCloseTo(band.expectedUsd, 10);
  });

  it("clamps counts it could not have produced rather than emitting a negative part", () => {
    for (const entry of decomposePlanCostEstimateFromCounts({
      targetFileCount: -4,
      taskCount: Number.NaN,
      model: MODEL,
    })) {
      expect(entry.expectedUsd).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(entry.expectedUsd)).toBe(true);
    }
  });
});

describe("the configured minimum sample size (#490 AC1)", () => {
  it("defaults when nothing is configured", () => {
    expect(DEFAULT_MINIMUM_SAMPLE_SIZE).toBe(10);
    expect(resolveMinimumSampleSize({})).toBe(DEFAULT_MINIMUM_SAMPLE_SIZE);
  });

  it("reads the configured override", () => {
    expect(resolveMinimumSampleSize({ [MINIMUM_SAMPLE_SIZE_ENV]: "3" })).toBe(3);
    expect(resolveMinimumSampleSize({ [MINIMUM_SAMPLE_SIZE_ENV]: "250" })).toBe(250);
  });

  it("falls back on a value that is not a usable sample size", () => {
    for (const bad of ["0", "-2", "3.7", "abc", "", " 5 ", "1e3"]) {
      expect(resolveMinimumSampleSize({ [MINIMUM_SAMPLE_SIZE_ENV]: bad })).toBe(
        DEFAULT_MINIMUM_SAMPLE_SIZE,
      );
    }
  });
});

describe("the script's wiring (#490)", () => {
  it("consumes the ledger, the usage query and the report module", () => {
    expect(SCRIPT).toContain("createRunHistoryStore");
    expect(SCRIPT).toContain("createUsageStore");
    expect(SCRIPT).toContain("queryUsage");
    expect(SCRIPT).toContain("listPlanEstimates");
    expect(SCRIPT).toContain("buildCalibrationReport");
    expect(SCRIPT).toContain("decomposePlanCostEstimateFromCounts");
  });

  it("does NOT read the accuracy view, whose actual column nothing populates yet", () => {
    // The view joins df_run_summaries.cost_usd, which is NULL on every run, so a report built on it
    // would silently report an empty sample rather than a real one.
    expect(SCRIPT).not.toContain("listEstimateAccuracy");
  });

  it("uses the configured minimum rather than a literal", () => {
    expect(SCRIPT).toContain("resolveMinimumSampleSize");
    expect(SCRIPT).not.toMatch(/minimumSampleSize:\s*\d/);
  });
});
