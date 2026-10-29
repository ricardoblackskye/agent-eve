import { describe, expect, it } from "vitest";
import {
  buildCalibrationReport,
  type CalibrationPair,
} from "../../agent/lib/dark-factory/calibration-report";
import type { CostClass } from "../../agent/lib/dark-factory/plan-cost-estimate";

function pair(overrides: Partial<CalibrationPair> = {}): CalibrationPair {
  return {
    runId: "run-1",
    costClass: "XS" as CostClass,
    confidence: "low",
    expectedUsd: 0.2,
    actualUsd: 0.1,
    stageActualUsd: { architect: 0.04, developer: 0.06 },
    stageExpectedUsd: { architect: 0.08, developer: 0.12 },
    ...overrides,
  };
}

/** Two pairs, each 0.10 high: bias 0.10, MAE 0.10, MAPE 75%. Factors 0.5 and 0.667. */
const OVERSHOOTING = [
  pair({ runId: "run-1", expectedUsd: 0.2, actualUsd: 0.1 }),
  pair({ runId: "run-2", expectedUsd: 0.3, actualUsd: 0.2 }),
];

describe("calibration report (#490)", () => {
  const report = (pairs: CalibrationPair[], minimumSampleSize = 2, runsWithoutEstimate = 0) =>
    buildCalibrationReport({ pairs, minimumSampleSize, runsWithoutEstimate });

  it("leads with SIGNED bias, positive when the estimator was high", () => {
    const built = report(OVERSHOOTING);
    expect(built.bias.value).toBeCloseTo(0.1, 10);
    expect(built.bias.sampleSize).toBe(2);
  });

  it("reports MAE in dollars and MAPE as a percentage", () => {
    const built = report(OVERSHOOTING);
    expect(built.mae.value).toBeCloseTo(0.1, 10);
    expect(built.mape.value).toBeCloseTo(75, 10);
  });

  it("emits the multiplicative factor v2 consumes", () => {
    const built = report(OVERSHOOTING);
    // Derived, not assumed: each pair contributes actual / estimate.
    expect(built.factor).toBeCloseTo((0.1 / 0.2 + 0.2 / 0.3) / 2, 10);
  });

  it("excludes a run with no estimate rather than counting it as zero", () => {
    const withoutCounting = report(OVERSHOOTING, 2, 0);
    const withThreeExcluded = report(OVERSHOOTING, 2, 3);

    expect(withThreeExcluded.excludedWithoutEstimate).toBe(3);
    expect(withThreeExcluded.sampleSize).toBe(2);
    // The whole point: an excluded run must not drag a single metric towards zero.
    expect(withThreeExcluded.bias.value).toBeCloseTo(withoutCounting.bias.value!, 10);
    expect(withThreeExcluded.mae.value).toBeCloseTo(withoutCounting.mae.value!, 10);
    expect(withThreeExcluded.mape.value).toBeCloseTo(withoutCounting.mape.value!, 10);
    expect(withThreeExcluded.factor).toBeCloseTo(withoutCounting.factor!, 10);
  });

  it("never reports the tester, and a tester row moves no number", () => {
    const withTester = report(
      OVERSHOOTING.map((entry) => ({
        ...entry,
        stageActualUsd: { ...entry.stageActualUsd, tester: 9 },
        stageExpectedUsd: { ...entry.stageExpectedUsd, tester: 9 },
      })),
    );
    const withoutTester = report(OVERSHOOTING);

    expect(withTester.byStage.map((entry) => entry.stage)).toEqual(["architect", "developer"]);
    expect(withTester.bias.value).toBeCloseTo(withoutTester.bias.value!, 10);
    expect(withTester.factor).toBeCloseTo(withoutTester.factor!, 10);
  });

  it("breaks the metrics down by stage and by cost class, each with its sample size", () => {
    const built = report([
      pair({ runId: "a", costClass: "XS", expectedUsd: 0.2, actualUsd: 0.1 }),
      pair({ runId: "b", costClass: "M", expectedUsd: 1.2, actualUsd: 1.0 }),
    ]);

    const architect = built.byStage.find((entry) => entry.stage === "architect")!;
    expect(architect.bias.sampleSize).toBe(2);
    expect(architect.bias.value).toBeCloseTo((0.08 - 0.04 + 0.08 - 0.04) / 2, 10);

    const classes = built.byCostClass.map((entry) => entry.costClass);
    expect(classes).toContain("XS");
    expect(classes).toContain("M");
    const xs = built.byCostClass.find((entry) => entry.costClass === "XS")!;
    expect(xs.bias.sampleSize).toBe(1);
    expect(xs.bias.value).toBeCloseTo(0.1, 10);
  });

  it("carries a sample size on every metric it publishes", () => {
    const built = report(OVERSHOOTING);
    const groups = [...built.byStage, ...built.byCostClass];
    const metrics = [
      built.bias,
      built.mae,
      built.mape,
      ...groups.map((group) => group.bias),
      ...groups.map((group) => group.mae),
      ...groups.map((group) => group.mape),
    ];
    for (const metric of metrics) {
      expect(typeof metric.sampleSize).toBe("number");
      expect(metric.sampleSize).toBeGreaterThan(0);
    }
  });

  it("withholds EVERY metric below the minimum sample size, and says why", () => {
    const withheld = report(OVERSHOOTING, 5);
    expect(withheld.reportable).toBe(false);
    expect(withheld.reason).toBe("below-minimum-sample-size");
    expect(withheld.bias.value).toBeUndefined();
    expect(withheld.mae.value).toBeUndefined();
    expect(withheld.mape.value).toBeUndefined();
    expect(withheld.factor).toBeUndefined();
    expect(withheld.byStage).toEqual([]);
    expect(withheld.byCostClass).toEqual([]);
    // The counts still come through: a withheld report must not look like an empty one.
    expect(withheld.sampleSize).toBe(2);
    expect(withheld.bias.sampleSize).toBe(2);
  });

  it("reports at EXACTLY the minimum sample size — the boundary case", () => {
    const atMinimum = report(OVERSHOOTING, 2);
    expect(atMinimum.reportable).toBe(true);
    expect(atMinimum.reason).toBeUndefined();
    expect(atMinimum.bias.value).toBeCloseTo(0.1, 10);
    expect(atMinimum.factor).toBeCloseTo((0.1 / 0.2 + 0.2 / 0.3) / 2, 10);
  });

  it("keeps MAPE finite when a run's actual is zero, excluding it from that metric only", () => {
    const built = report([
      pair({ runId: "paid", expectedUsd: 0.2, actualUsd: 0.1 }),
      pair({ runId: "free", expectedUsd: 0.2, actualUsd: 0 }),
    ]);

    expect(built.mape.sampleSize).toBe(1);
    expect(Number.isFinite(built.mape.value!)).toBe(true);
    expect(built.mape.value).toBeCloseTo(100, 10);
    expect(built.bias.sampleSize).toBe(2);
    expect(built.bias.value).toBeCloseTo(0.15, 10);
  });

  it("is deterministic — the same input yields a byte-identical report", () => {
    expect(JSON.stringify(report(OVERSHOOTING))).toBe(JSON.stringify(report(OVERSHOOTING)));
  });
});
