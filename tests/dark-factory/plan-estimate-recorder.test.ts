/**
 * #487 - the best-effort estimate recorder.
 *
 * The recorder must never throw: a ledger outage or an unusable feature set has to come back as a
 * result, because the runner proceeds either way.
 */
import { describe, expect, it, vi } from "vitest";
import {
  recordPlanEstimateSafely,
  type RecordPlanEstimateInput,
} from "../../agent/lib/dark-factory/plan-estimate-recorder";
import type {
  PersistedPlanEstimate,
  PlanEstimateRecordInput,
  PlanLedger,
} from "../../agent/lib/dark-factory/plan-ledger";
import { PLAN_ESTIMATOR_VERSION } from "../../agent/lib/dark-factory/plan-cost-estimate";

const PLAN = { targetFiles: ["src/a.ts", "src/b.ts"], tasks: [{ id: "t1" }] } as never;

function fakeLedger(
  behaviour: "ok" | "throws",
): { ledger: PlanLedger; calls: PlanEstimateRecordInput[] } {
  const calls: PlanEstimateRecordInput[] = [];
  const ledger = {
    recordPlan: vi.fn(),
    listPlans: vi.fn(),
    listPlanEstimates: vi.fn(),
    recordPlanEstimate: vi.fn(async (row: PlanEstimateRecordInput) => {
      calls.push(row);
      if (behaviour === "throws") throw new Error("ledger unreachable");
      return { ...row, estimateId: 7, estimatorVersion: PLAN_ESTIMATOR_VERSION } as PersistedPlanEstimate;
    }),
  } as unknown as PlanLedger;
  return { ledger, calls };
}

function baseInput(over: Partial<RecordPlanEstimateInput> = {}): RecordPlanEstimateInput {
  return {
    plan: PLAN,
    planId: 42,
    runId: "run-487",
    model: "deepseek/deepseek-v4.1-flash",
    period: "2026-10",
    now: new Date("2026-10-27T12:00:00.000Z"),
    ...over,
  };
}

/** A band whose features carry every key the typed columns are derived from. */
function usableFeatures() {
  return {
    targetFileCount: 2,
    taskCount: 1,
    inputTokens: 12_000,
    outputTokens: 9_000,
    priceInputUsdPer1k: 0.0007,
    priceOutputUsdPer1k: 0.02,
    priceSource: "known-model",
    revisionFactor: 1,
    historySampleCount: 0,
  };
}

describe("#487 recordPlanEstimateSafely", () => {
  it("persists an estimate and returns it", async () => {
    const { ledger, calls } = fakeLedger("ok");
    const result = await recordPlanEstimateSafely(ledger, baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.estimate.estimateId).toBe(7);
    expect(calls).toHaveLength(1);
    expect(result.computed.expectedUsd).toBeGreaterThan(0);
  });

  it("derives the typed columns from the estimator's features", async () => {
    const { ledger, calls } = fakeLedger("ok");
    await recordPlanEstimateSafely(
      ledger,
      baseInput({
        estimate: () => ({
          lowUsd: 0.1, expectedUsd: 0.2, highUsd: 0.4,
          costClass: "XS", confidence: "low", features: usableFeatures(),
        }),
      }),
    );
    expect(calls).toHaveLength(1);
    const row = calls[0];
    expect(row.planId).toBe(42);
    expect(row.runId).toBe("run-487");
    expect(row.period).toBe("2026-10");
    expect(row.targetFileCount).toBe(2);
    expect(row.taskCount).toBe(1);
    expect(row.inputTokens).toBe(12_000);
    expect(row.outputTokens).toBe(9_000);
    expect(row.priceSource).toBe("known-model");
    expect(row.revisionFactor).toBe(1);
    expect(row.historySamples).toBe(0);
    expect(row.expectedUsd).toBe(0.2);
    expect(row.costClass).toBe("XS");
    // the version is stamped EXPLICITLY rather than left to a store default
    expect(row.estimatorVersion).toBe(PLAN_ESTIMATOR_VERSION);
    expect(row.createdAt).toBe("2026-10-27T12:00:00.000Z");
  });

  it("does NOT throw when the ledger rejects, and reports why", async () => {
    const { ledger } = fakeLedger("throws");
    const result = await recordPlanEstimateSafely(ledger, baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("ledger unreachable");
  });

  it("refuses to invent typed columns from an unusable feature set", async () => {
    const { ledger, calls } = fakeLedger("ok");
    const features = usableFeatures();
    delete (features as Record<string, unknown>).revisionFactor;
    const result = await recordPlanEstimateSafely(
      ledger,
      baseInput({
        estimate: () => ({
          lowUsd: 0.1, expectedUsd: 0.2, highUsd: 0.4,
          costClass: "XS", confidence: "low", features,
        }),
      }),
    );
    // No row is written at all: a zero-filled row would enter the calibration rollup as a real number.
    expect(calls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("revisionFactor");
  });

  it("never throws even when the ledger rejects with a non-Error", async () => {
    const ledger = {
      recordPlanEstimate: vi.fn(async () => {
        throw "a string rejection";
      }),
    } as unknown as PlanLedger;
    const result = await recordPlanEstimateSafely(ledger, baseInput());
    expect(result.ok).toBe(false);
  });
});
