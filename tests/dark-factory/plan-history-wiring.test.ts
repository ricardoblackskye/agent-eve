import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PLAN_ESTIMATOR_VERSION } from "../../agent/lib/dark-factory/plan-cost-estimate";

/**
 * Source guards for the wiring (#533), the repo's convention where behaviour lives behind a seam that is
 * unit-tested and what needs pinning is the call the composition root makes.
 */
const RUNNER = readFileSync(resolve(process.cwd(), "scripts/dark-factory-runner.ts"), "utf8");

describe("the estimator is given history (#533)", () => {
  it("reads the window from the store it already holds", () => {
    expect(RUNNER).toContain("readPlanHistory(");
    expect(RUNNER).toMatch(/readPlanHistory\(\s*runHistory/);
  });

  it("passes that history into the estimate, which is the whole point", () => {
    const index = RUNNER.indexOf("estimatePlanCostSafely({");
    expect(index).toBeGreaterThan(-1);
    const call = RUNNER.slice(index, index + 400);
    expect(call).toMatch(/history:/);
  });

  it("stamps bands from the new behaviour differently — v2, so a calibration cannot blend them", () => {
    // The constant lives in the estimator, not the runner: the point is that the set of bands produced
    // from here on is distinguishable from every band produced before history was wired in.
    expect(PLAN_ESTIMATOR_VERSION).toBe("v2");
  });
});
