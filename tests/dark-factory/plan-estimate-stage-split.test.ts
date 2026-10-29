import { describe, expect, it } from "vitest";
import {
  ARCHITECT_OUTPUT_TOKENS,
  CHARS_PER_TOKEN,
  MAX_CHARS_PER_FILE,
  MAX_CONTEXT_FILES_READ,
  OUTPUT_TOKENS_PER_TASK,
  decomposePlanCostEstimate,
  estimatePlanCost,
} from "../../agent/lib/dark-factory/plan-cost-estimate";
import { resolvePrice } from "../../agent/lib/dark-factory/cost-budget";
import type { ExecutionPlan, PlanTargetFile, PlanTask } from "../../agent/lib/dark-factory/plan-validator";

const MODEL = "deepseek/deepseek-v4.1-flash";
const PRICE = resolvePrice(MODEL)!;

function files(count: number): PlanTargetFile[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `file-${i}.ts`,
    action: "modify" as const,
    rationale: "structural fixture",
  }));
}

function tasks(count: number): PlanTask[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `task ${i}`,
    objective: "structural fixture",
  }));
}

function plan(fileCount: number, taskCount: number): ExecutionPlan {
  return {
    storyId: 490,
    title: "calibration report",
    summary: "the loop closes",
    targetFiles: files(fileCount),
    tasks: tasks(taskCount),
    acceptanceCriteriaMap: [],
  };
}

function part(fileCount: number, taskCount: number, stage: "architect" | "developer"): number {
  const found = decomposePlanCostEstimate({ plan: plan(fileCount, taskCount), model: MODEL })
    .find((entry) => entry.stage === stage);
  expect(found).toBeDefined();
  return found!.expectedUsd;
}

describe("plan-estimate stage split (#490)", () => {
  it("names both stages, architect first", () => {
    const parts = decomposePlanCostEstimate({ plan: plan(4, 2), model: MODEL });
    expect(parts.map((entry) => entry.stage)).toEqual(["architect", "developer"]);
  });

  it("sums to the whole-plan expectation, so the parts cannot drift from the band", () => {
    const estimate = estimatePlanCost({ plan: plan(6, 3), model: MODEL });
    const parts = decomposePlanCostEstimate({ plan: plan(6, 3), model: MODEL });
    const sum = parts.reduce((total, entry) => total + entry.expectedUsd, 0);
    expect(sum).toBeCloseTo(estimate.expectedUsd, 10);
  });

  it("prices the architect as one context read plus the planning output", () => {
    const contextTokens = Math.min(4, MAX_CONTEXT_FILES_READ) * (MAX_CHARS_PER_FILE / CHARS_PER_TOKEN);
    const expected =
      (contextTokens / 1000) * PRICE.inputUsdPer1k +
      (ARCHITECT_OUTPUT_TOKENS / 1000) * PRICE.outputUsdPer1k;
    expect(part(4, 2, "architect")).toBeCloseTo(expected, 10);
  });

  it("prices the developer as the other context read plus the per-task output", () => {
    const contextTokens = Math.min(4, MAX_CONTEXT_FILES_READ) * (MAX_CHARS_PER_FILE / CHARS_PER_TOKEN);
    const expected =
      (contextTokens / 1000) * PRICE.inputUsdPer1k +
      ((3 * OUTPUT_TOKENS_PER_TASK) / 1000) * PRICE.outputUsdPer1k;
    expect(part(4, 3, "developer")).toBeCloseTo(expected, 10);
  });

  it("moves only the developer's share when tasks are added — the control for the split", () => {
    expect(part(4, 5, "architect")).toBeCloseTo(part(4, 2, "architect"), 10);
    expect(part(4, 5, "developer")).toBeGreaterThan(part(4, 2, "developer"));
  });

  it("charges the same context read to both stages, so a file change moves both equally", () => {
    const extraReadUsd =
      ((Math.min(4, MAX_CONTEXT_FILES_READ) * (MAX_CHARS_PER_FILE / CHARS_PER_TOKEN)) / 1000) *
      PRICE.inputUsdPer1k;
    expect(part(8, 2, "architect") - part(4, 2, "architect")).toBeCloseTo(extraReadUsd, 10);
    expect(part(8, 2, "developer") - part(4, 2, "developer")).toBeCloseTo(extraReadUsd, 10);
  });

  it("keeps every part non-negative for an empty plan", () => {
    for (const entry of decomposePlanCostEstimate({ plan: plan(0, 0), model: MODEL })) {
      expect(entry.expectedUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it("scales with the revision factor, so the parts still sum when history applies", () => {
    const history = [
      { iterationCount: 2, fixCycleCount: 1 },
      { iterationCount: 3, fixCycleCount: 0 },
    ] as unknown as Parameters<typeof estimatePlanCost>[0]["history"];
    const estimate = estimatePlanCost({ plan: plan(4, 2), model: MODEL, history });
    expect(estimate.features.revisionFactor).toBeGreaterThan(1);
    const parts = decomposePlanCostEstimate({ plan: plan(4, 2), model: MODEL, history });
    const sum = parts.reduce((total, entry) => total + entry.expectedUsd, 0);
    expect(sum).toBeCloseTo(estimate.expectedUsd, 10);
  });

  it("is deterministic — the same input yields byte-identical parts", () => {
    const first = decomposePlanCostEstimate({ plan: plan(5, 4), model: MODEL });
    const second = decomposePlanCostEstimate({ plan: plan(5, 4), model: MODEL });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
