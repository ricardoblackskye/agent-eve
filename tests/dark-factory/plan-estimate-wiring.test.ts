/**
 * #487 - the runner wiring: composition, the resume guard, and the ordering.
 *
 * The ordering is asserted against the SOURCE, following the precedent in plan-approval.test.ts:
 * neither the relative order of the comment, the estimate and the park is observable from a unit test
 * of any module, and the ordering IS the requirement. The composition and the predicate are tested
 * behaviourally; only the placement is structural.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  recordPlanWithEstimateSafely,
  type RecordPlanWithEstimateInput,
} from "../../agent/lib/dark-factory/plan-estimate-recorder";
import type {
  PersistedPlan,
  PersistedPlanEstimate,
  PlanEstimateRecordInput,
  PlanLedger,
  PlanRecordInput,
} from "../../agent/lib/dark-factory/plan-ledger";
import { shouldRecordPlanEstimate } from "../../scripts/dark-factory-runner";

const PLAN = { targetFiles: ["src/a.ts"], tasks: [{ id: "t1" }] } as never;
const FEATURES = {
  targetFileCount: 1,
  taskCount: 1,
  inputTokens: 12_000,
  outputTokens: 9_000,
  priceInputUsdPer1k: 0.0007,
  priceOutputUsdPer1k: 0.02,
  priceSource: "known-model",
  revisionFactor: 1,
  historySampleCount: 0,
};

function recordingLedger(failPlan = false, failEstimate = false) {
  const plans: PlanRecordInput[] = [];
  const estimates: PlanEstimateRecordInput[] = [];
  const ledger = {
    recordPlan: vi.fn(async (row: PlanRecordInput) => {
      plans.push(row);
      if (failPlan) throw new Error("plan insert refused");
      return { ...row, planId: 99 } as PersistedPlan;
    }),
    recordPlanEstimate: vi.fn(async (row: PlanEstimateRecordInput) => {
      estimates.push(row);
      if (failEstimate) throw new Error("estimate insert refused");
      return { ...row, estimateId: 5 } as PersistedPlanEstimate;
    }),
    listPlans: vi.fn(),
    listPlanEstimates: vi.fn(),
  } as unknown as PlanLedger;
  return { ledger, plans, estimates };
}

function baseInput(over: Partial<RecordPlanWithEstimateInput> = {}): RecordPlanWithEstimateInput {
  return {
    plan: PLAN,
    runId: "run-487",
    model: "deepseek/deepseek-v4.1-flash",
    period: "2026-10",
    planRevision: 1,
    storyId: 487,
    source: "architect",
    now: new Date("2026-10-27T12:00:00.000Z"),
    estimate: () => ({
      lowUsd: 0.1, expectedUsd: 0.2, highUsd: 0.4,
      costClass: "XS", confidence: "low", features: FEATURES,
    }),
    ...over,
  };
}

describe("#487 shouldRecordPlanEstimate", () => {
  it("records a fresh dispatch", () => {
    expect(shouldRecordPlanEstimate({ resuming: false, revision: false })).toBe(true);
  });

  it("records a revision round, because that plan is new", () => {
    expect(shouldRecordPlanEstimate({ resuming: true, revision: true })).toBe(true);
  });

  it("does NOT record on a plain resume, which reuses the approved plan", () => {
    expect(shouldRecordPlanEstimate({ resuming: true, revision: false })).toBe(false);
  });
});

describe("#487 recordPlanWithEstimateSafely", () => {
  it("records the plan with its comment ref, then the estimate against that plan", async () => {
    const { ledger, plans, estimates } = recordingLedger();
    const result = await recordPlanWithEstimateSafely(
      ledger,
      baseInput({ commentRef: { provider: "github", id: 4242, url: "https://example.invalid/4242" } }),
    );
    expect(result.ok).toBe(true);
    expect(plans).toHaveLength(1);
    expect(plans[0].commentRef?.id).toBe(4242);
    expect(plans[0].source).toBe("architect");
    expect(plans[0].planRevision).toBe(1);
    expect(plans[0].createdAt).toBe("2026-10-27T12:00:00.000Z");
    // the estimate is a CHILD of the plan row, so it carries the id the plan insert returned
    expect(estimates).toHaveLength(1);
    expect(estimates[0].planId).toBe(99);
    expect(estimates[0].runId).toBe("run-487");
  });

  it("reports a failed plan without inventing an estimate for it", async () => {
    const { ledger, estimates } = recordingLedger(true, false);
    const result = await recordPlanWithEstimateSafely(ledger, baseInput());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("plan insert refused");
    expect(estimates).toHaveLength(0);
  });

  it("keeps the plan when only the estimate fails, and says so separately", async () => {
    const { ledger } = recordingLedger(false, true);
    const result = await recordPlanWithEstimateSafely(ledger, baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.planId).toBe(99);
    expect(result.estimate).toBeUndefined();
    expect(result.estimateError).toContain("estimate insert refused");
  });

  it("never throws, whatever the ledger does", async () => {
    const ledger = {
      recordPlan: vi.fn(async () => {
        throw "a string rejection";
      }),
    } as unknown as PlanLedger;
    await expect(recordPlanWithEstimateSafely(ledger, baseInput())).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe("#487 the estimate is persisted after the comment and before the park", () => {
  it("places the persistence between postPlanComment and the approval park", () => {
    const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");
    const commentAt = runner.indexOf("await postPlanComment(");
    const recordAt = runner.indexOf("await recordPlanWithEstimateSafely(");
    const gateAt = runner.indexOf("parksForHumanApproval({");
    expect(commentAt).toBeGreaterThan(-1);
    expect(recordAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    // Option B: the plan row needs the comment id, so the comment goes first; the numbers must be
    // durable before the run parks and a human is told the plan is ready.
    expect(commentAt).toBeLessThan(recordAt);
    expect(recordAt).toBeLessThan(gateAt);
  });

  it("guards the persistence on the predicate rather than recording unconditionally", () => {
    const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");
    const guardAt = runner.indexOf("shouldRecordPlanEstimate({");
    const recordAt = runner.indexOf("await recordPlanWithEstimateSafely(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(recordAt);
  });
});
