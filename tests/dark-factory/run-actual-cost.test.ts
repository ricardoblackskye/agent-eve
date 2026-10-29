import { describe, expect, it } from "vitest";
import { sumRunActualCost } from "../../agent/lib/dark-factory/run-actual-cost";

describe("run actual cost (#531)", () => {
  it("sums both sources, so one path alone cannot satisfy it", () => {
    const total = sumRunActualCost({ usageCostUsd: 0.02, eventCostUsd: 0.03 });
    expect(total.costUsd).toBeCloseTo(0.05, 10);
    expect(total.costUsd).not.toBeCloseTo(0.02, 10);
    expect(total.costUsd).not.toBeCloseTo(0.03, 10);
  });

  it("reports the parts alongside the total, so the two paths stay distinguishable", () => {
    expect(sumRunActualCost({ usageCostUsd: 0.02, eventCostUsd: 0.03 }).sources).toEqual({
      usageCostUsd: 0.02,
      eventCostUsd: 0.03,
    });
  });

  it("treats each source as independent — the ledger alone is a valid run", () => {
    expect(sumRunActualCost({ usageCostUsd: 0.0932 }).costUsd).toBeCloseTo(0.0932, 10);
    expect(sumRunActualCost({ eventCostUsd: 0.4 }).costUsd).toBeCloseTo(0.4, 10);
  });

  it("is 0, not NaN or undefined, when neither source recorded anything", () => {
    for (const sources of [{}, { usageCostUsd: undefined, eventCostUsd: undefined }]) {
      const total = sumRunActualCost(sources);
      expect(total.costUsd).toBe(0);
      expect(Number.isFinite(total.costUsd)).toBe(true);
    }
  });

  it("ignores a negative or non-finite value rather than propagating it", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const total = sumRunActualCost({ usageCostUsd: bad, eventCostUsd: 0.05 });
      expect(Number.isFinite(total.costUsd)).toBe(true);
      expect(total.costUsd).toBeCloseTo(0.05, 10);
    }
  });

  it("ignores an unusable value on its own side only, keeping the other", () => {
    const total = sumRunActualCost({ usageCostUsd: 0.02, eventCostUsd: Number.NaN });
    expect(total.costUsd).toBeCloseTo(0.02, 10);
    expect(total.sources.eventCostUsd).toBe(0);
  });

  it("is deterministic — the same input yields a byte-identical result", () => {
    const input = { usageCostUsd: 0.02, eventCostUsd: 0.03 };
    expect(JSON.stringify(sumRunActualCost(input))).toBe(JSON.stringify(sumRunActualCost(input)));
  });
});
