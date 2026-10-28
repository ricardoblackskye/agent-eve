import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderCostEstimateSection } from "../../agent/lib/dark-factory/plan-comment";
import type { PlanCostEstimate } from "../../agent/lib/dark-factory/plan-cost-estimate";
import { estimatePlanCostSafely } from "../../agent/lib/dark-factory/plan-cost-estimate";

/**
 * #488 — the estimate section of the plan comment (epic #453).
 *
 * The plan comment is v1's ONLY surface for the estimate, so the WORDING is the deliverable: a forecast
 * shown to a human deciding whether to approve a run must read as a band and never as a quote, and it
 * must never block anything.
 */
function estimate(over: Partial<PlanCostEstimate> = {}): PlanCostEstimate {
  return {
    lowUsd: 0.1,
    expectedUsd: 0.2,
    highUsd: 0.41,
    costClass: "XS",
    confidence: "low",
    features: {},
    ...over,
  };
}

describe("#488 the estimate section of the plan comment", () => {
  it("renders the band, the class and the confidence", () => {
    const section = renderCostEstimateSection(estimate());
    expect(section).toContain("$0.10");
    expect(section).toContain("$0.41");
    expect(section).toContain("XS");
    expect(section).toMatch(/confidence[^a-z]*low/i);
  });

  it("renders the band low-to-high, so the two ends cannot collapse into one figure", () => {
    const section = renderCostEstimateSection(estimate({ lowUsd: 0.1, highUsd: 0.41 }));
    expect(section.indexOf("$0.10")).toBeGreaterThan(-1);
    expect(section.indexOf("$0.10")).toBeLessThan(section.indexOf("$0.41"));
  });

  it("says the figure is advisory and does not block approval", () => {
    const section = renderCostEstimateSection(estimate());
    expect(section).toMatch(/advisory/i);
    expect(section).toMatch(/does not block/i);
  });

  it("never renders the middle figure, which is what would read as a quote", () => {
    // AC4. expectedUsd is what a single-figure sentence would print; the band is the only output.
    const section = renderCostEstimateSection(estimate({ expectedUsd: 0.2 }));
    expect(section).not.toContain("$0.20");
    expect(section).not.toMatch(/expected cost is/i);
  });

  it("renders NOTHING when there is no estimate", () => {
    expect(renderCostEstimateSection(undefined)).toBe("");
    expect(renderCostEstimateSection(null)).toBe("");
  });

  it("never substitutes a placeholder for a missing estimate", () => {
    // AC3. The absence has exactly one voice: no section at all. "unknown" or "$0" would read as a
    // measurement, and a reader cannot tell a placeholder from a real zero.
    for (const nothing of [undefined, null]) {
      const section = renderCostEstimateSection(nothing);
      expect(section).not.toMatch(/unknown/i);
      expect(section).not.toContain("$0");
      expect(section.trim()).toBe("");
    }
  });

  it("RENDERS a computed zero band — a computed estimate is never suppressed", () => {
    // Settled at GATE 1: suppressing a real estimate would make "computed, and zero" indistinguishable
    // from "no estimate", leaving one silence carrying two meanings.
    const section = renderCostEstimateSection(
      estimate({ lowUsd: 0, expectedUsd: 0, highUsd: 0 }),
    );
    expect(section).not.toBe("");
    expect(section).toContain("$0.00");
  });

  it("rounds to cents and never prints exponent notation", () => {
    const section = renderCostEstimateSection(estimate({ lowUsd: 0.126, highUsd: 1234.5 }));
    expect(section).toContain("$0.13");
    expect(section).toContain("$1234.50");
    expect(section).not.toMatch(/[0-9]e[+-]?[0-9]/i);
  });
});

/**
 * #488 — a plan that cannot be priced must still post a comment, and the numbers a human approves must be
 * the numbers the ledger keeps.
 */
describe("#488 a plan that cannot be priced still posts a comment", () => {
  const PLAN = {
    targetFiles: [{ path: "a.ts", action: "modify", rationale: "add a line" }],
    tasks: [{ title: "t" }],
  } as never;

  it("returns the computed estimate", () => {
    const result = estimatePlanCostSafely({
      plan: PLAN,
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(result).toBeDefined();
    expect(result === undefined ? 0 : result.highUsd).toBeGreaterThan(
      result === undefined ? 0 : result.lowUsd,
    );
  });

  it("never throws when the price source fails", () => {
    // The band is an OBSERVATION about a run, not a control over it: an unpriced plan must still post a
    // readable comment rather than stopping the dispatch. Mirrors recordPlanEstimateSafely (#487).
    const result = estimatePlanCostSafely({
      plan: PLAN,
      model: "some-model",
      resolvePrice: () => {
        throw new Error("price source down");
      },
    });
    expect(result).toBeUndefined();
  });
});

/**
 * The ordering and the single-value guarantee are asserted against the SOURCE, following the precedent in
 * plan-approval.test.ts: neither is observable from a unit test of any module, and both ARE the requirement.
 */
describe("#488 the runner prices the plan once, before the comment", () => {
  const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");

  it("computes the estimate BEFORE posting the comment", () => {
    const computeAt = runner.indexOf("estimatePlanCostSafely(");
    const commentAt = runner.indexOf("await postPlanComment(");
    expect(computeAt).toBeGreaterThan(-1);
    expect(commentAt).toBeGreaterThan(-1);
    expect(computeAt).toBeLessThan(commentAt);
  });

  it("hands the ONE computed value to the comment and to the ledger", () => {
    const commentAt = runner.indexOf("await postPlanComment(");
    const persistAt = runner.indexOf("await recordPlanWithEstimateSafely(");
    expect(commentAt).toBeGreaterThan(-1);
    expect(persistAt).toBeGreaterThan(commentAt);
    expect(runner.slice(commentAt, persistAt)).toContain("estimate: planEstimate");
    expect(runner.slice(persistAt, persistAt + 900)).toContain("planEstimate");
  });
});
