import { describe, expect, it } from "vitest";

import { renderCostEstimateSection } from "../../agent/lib/dark-factory/plan-comment";
import type { PlanCostEstimate } from "../../agent/lib/dark-factory/plan-cost-estimate";

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
