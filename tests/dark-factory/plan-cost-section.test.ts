import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parsePlanFromComment,
  planCommentBody,
  renderCostEstimateSection,
  parsePlanFromComments,
  planBlockBody,
} from "../../agent/lib/dark-factory/plan-comment";
import { renderPlanFile } from "../../agent/lib/dark-factory/plan-file";
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

/**
 * AC6 — the comment's size for a plan at the top of what the Architect can produce.
 *
 * `ARCHITECT_OUTPUT_TOKENS = 8000` (~32k chars) is the real budget, so this is an ordinary large plan rather
 * than a synthetic extreme. The body carries the plan TWICE (the human rendering, plus the machine-readable
 * block a resumed run reads back), which is where the size comes from.
 */
describe("#488 AC6 the comment's size for a large plan", () => {
  const GITHUB_COMMENT_LIMIT = 65536;
  const ESTIMATE = {
    lowUsd: 0.1,
    expectedUsd: 0.2,
    highUsd: 0.41,
    costClass: "XS" as const,
    confidence: "low" as const,
    features: {},
  };

  const largePlan = () => ({
    storyId: 488,
    title: "a deliberately large plan",
    approach: "x".repeat(2_000),
    tasks: Array.from({ length: 40 }, (_, index) => ({
      title: `Task ${index}`,
      objective: "y".repeat(400),
    })),
    targetFiles: Array.from({ length: 24 }, (_, index) => ({
      path: `src/some/deeply/nested/place/number-${index}/Component${index}.tsx`,
      action: "modify",
      rationale: "z".repeat(500),
    })),
  });

  const render = (plan: unknown) =>
    renderPlanFile(plan as never, {
      issueUrl: "https://github.com/owner/repo/issues/488",
    });

  it("keeps the section's own cost O(1), and still round-trips the plan at size", () => {
    const plan = largePlan();
    const markdown = render(plan);
    const withEstimate = planCommentBody(markdown, ESTIMATE);
    const withoutEstimate = planCommentBody(markdown);
    console.log(
      `[#488 AC6] with an estimate ${withEstimate.length} chars, without ${withoutEstimate.length} ` +
        `(limit ${GITHUB_COMMENT_LIMIT}); plan markdown alone ${markdown.length}`,
    );
    // The section renders three short facts and never the plan, so its cost does not scale with the plan:
    // this is the whole of #488's contribution to the body's size, whatever the plan's size.
    expect(withEstimate.length - withoutEstimate.length).toBeLessThan(400);
    // A body this large is exactly where a broken machine block would be hardest to notice.
    expect(
      parsePlanFromComments([
        { id: 1, body: withEstimate },
        { id: 2, body: planBlockBody(plan) },
      ]).ok,
    ).toBe(true);
  });

  /**
   * AC6's ABSOLUTE half was left UNMET by #488 — the same plan rendered 67,297 chars with the plan carried
   * twice — and it was tracked in #518 rather than silently widened into #488. #518 delivered it by moving the
   * machine block into its own comment, so EACH comment is now bounded, and this pins that.
   */
  it("AC6 (absolute) a plan at the output budget keeps every comment under 65536 (#518)", () => {
    const plan = largePlan();
    const human = planCommentBody(render(plan), ESTIMATE);
    const block = planBlockBody(plan);
    expect(human.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
    expect(block.length).toBeLessThan(GITHUB_COMMENT_LIMIT);
    // Non-vacuity: the pair really did exceed one comment, so the bound is doing work.
    expect(human.length + block.length).toBeGreaterThan(GITHUB_COMMENT_LIMIT);
  });
});
