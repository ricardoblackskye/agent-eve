import { describe, expect, it } from "vitest";
import {
  InvalidPlanRecordError,
  toPlanEstimateRecord,
  toPlanRecord,
} from "../../agent/lib/dark-factory/plan-ledger";
import { PLAN_ESTIMATOR_VERSION } from "../../agent/lib/dark-factory/plan-cost-estimate";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

const at = "2026-10-26T12:00:00.000Z";

const plan: ExecutionPlan = {
  storyId: 486,
  title: "persist the estimate",
  summary: "a story",
  targetFiles: [{ path: "a.ts", action: "modify", rationale: "r" }],
  acceptanceCriteriaMap: [],
};

function planInput() {
  return {
    runId: "run-1",
    planRevision: 1,
    storyId: 486,
    source: "architect" as const,
    plan,
    createdAt: at,
  };
}

function estimateInput() {
  return {
    planId: 1,
    runId: "run-1",
    period: "2026-10",
    model: "deepseek/deepseek-v4.1-flash",
    lowUsd: 0.01,
    expectedUsd: 0.02352,
    highUsd: 0.04704,
    costClass: "XS" as const,
    confidence: "low" as const,
    revisionFactor: 1,
    historySamples: 0,
    targetFileCount: 2,
    taskCount: 0,
    inputTokens: 12_000,
    outputTokens: 8_000,
    priceSource: "known-model",
    features: { targetFileCount: 2, priceSource: "known-model" },
    createdAt: at,
  };
}

describe("plan record validation (#486)", () => {
  it("accepts a well-formed plan and keeps its structure", () => {
    const record = toPlanRecord(planInput());
    expect(record.runId).toBe("run-1");
    expect(record.planRevision).toBe(1);
    expect(record.source).toBe("architect");
    expect(record.plan.targetFiles).toHaveLength(1);
  });

  it("keeps an optional tenant and comment reference", () => {
    const record = toPlanRecord({
      ...planInput(),
      tenantId: "tenant-a",
      commentRef: { provider: "github", id: 42, url: "https://example.test/c/42" },
    });
    expect(record.tenantId).toBe("tenant-a");
    expect(record.commentRef?.id).toBe(42);
  });

  it("discards unknown fields instead of carrying them into the row", () => {
    const record = toPlanRecord({ ...planInput(), prompt: "do not store me" } as never);
    expect(record).not.toHaveProperty("prompt");
  });

  it("refuses a blank run id, an unknown source and a negative revision", () => {
    expect(() => toPlanRecord({ ...planInput(), runId: "  " })).toThrow(InvalidPlanRecordError);
    expect(() => toPlanRecord({ ...planInput(), source: "wizard" as never })).toThrow(/source/i);
    expect(() => toPlanRecord({ ...planInput(), planRevision: -1 })).toThrow(/planRevision/i);
  });
});

describe("plan estimate record validation (#486)", () => {
  it("accepts an ordered band and stamps the estimator version", () => {
    const record = toPlanEstimateRecord(estimateInput());
    expect(record.expectedUsd).toBeCloseTo(0.02352, 8);
    expect(record.costClass).toBe("XS");
    // Version is stamped so a later recalibration cannot be averaged with this row (#490).
    expect(record.estimatorVersion).toBe(PLAN_ESTIMATOR_VERSION);
  });

  it("honours an explicit estimator version", () => {
    expect(
      toPlanEstimateRecord({ ...estimateInput(), estimatorVersion: "v0" }).estimatorVersion,
    ).toBe("v0");
  });

  it("refuses an INVERTED band - it is not a band", () => {
    expect(() =>
      toPlanEstimateRecord({ ...estimateInput(), lowUsd: 9, expectedUsd: 1 }),
    ).toThrow(/ordered/i);
  });

  it("refuses an unknown cost class and an unknown confidence", () => {
    expect(() =>
      toPlanEstimateRecord({ ...estimateInput(), costClass: "HUGE" as never }),
    ).toThrow(/costClass/i);
    expect(() =>
      toPlanEstimateRecord({ ...estimateInput(), confidence: "certain" as never }),
    ).toThrow(/confidence/i);
  });

  it("refuses a non-scalar feature value, which could only be prose", () => {
    expect(() =>
      toPlanEstimateRecord({
        ...estimateInput(),
        features: { nested: { body: "a whole issue" } } as never,
      }),
    ).toThrow(/features/i);
  });

  it("refuses a negative amount and a period that is not YYYY-MM", () => {
    expect(() => toPlanEstimateRecord({ ...estimateInput(), lowUsd: -1 })).toThrow(/lowUsd/i);
    expect(() =>
      toPlanEstimateRecord({ ...estimateInput(), period: "October" }),
    ).toThrow(/period/i);
  });
});
