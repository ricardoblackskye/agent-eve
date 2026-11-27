import { describe, expect, it } from "vitest";
import { renderPlanFile } from "../../agent/lib/dark-factory/plan-file";
import { isPageScopedStory, validateExecutionPlan, type ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #780 (R3) - two things the other test files do not establish.
 *
 * 1. The PLACEMENT. `substitution-declaration-763.test.ts` proves the line's format, and the renderer's own suites
 *    prove nothing else broke. Neither shows the line lands at the TOP of a rendered plan, which is the requirement's
 *    wording: "at the top of the plan as one line". A declaration that renders below the detail would pass both.
 *
 * 2. The REFUSAL that already exists. Rule 3b refuses a page-scoped story planned against the shell, and names the
 *    page to use instead. R3's plan said to verify and pin that rather than assume it or add a second refusal beside
 *    one that works - "a repair round that is told only 'wrong target' simply re-guesses".
 */
const NAMED_SURFACE = "src/pages/HomePage.jsx";
const SHELL = "src/App.jsx";
/** Proven to classify as page-scoped by the join test's precondition; asserted here too, so nothing passes hollow. */
const STORY = "On the home page, show a grid of products with the price of each one.";

const RENDER_INPUT = {
  storyId: 780,
  title: "Show a product grid on the home page",
  summary: "Add the grid.",
  targetFiles: [{ path: "src/components/ProductGrid.jsx", action: "modify", rationale: "the grid is composed here" }],
  acceptanceCriteriaMap: [],
};

const DECLARATION = {
  chosen: "src/components/ProductGrid.jsx",
  named: NAMED_SURFACE,
  reason: "the page composes the grid rather than containing it",
};

describe("#780 R3 - the declaration renders at the top, as one line", () => {
  it("places the declaration above every section", () => {
    const lines = renderPlanFile({ ...RENDER_INPUT, substitution: DECLARATION }).split("\n");
    const declaration = lines.findIndex((line) => line.startsWith("Substituted:"));
    const firstSection = lines.findIndex((line) => line.startsWith("## "));

    expect(declaration).toBeGreaterThan(-1);
    expect(firstSection).toBeGreaterThan(-1);
    expect(declaration).toBeLessThan(firstSection);
  });

  it("renders it exactly once - one line, not a paragraph", () => {
    const rendered = renderPlanFile({ ...RENDER_INPUT, substitution: DECLARATION });

    expect(rendered.split("\n").filter((line) => line.startsWith("Substituted:")).length).toBe(1);
  });

  it("CONTROL: a plan with no substitution renders no declaration", () => {
    // Otherwise the renderer could print a placeholder line and the placement case would still pass.
    expect(renderPlanFile(RENDER_INPUT)).not.toContain("Substituted:");
  });
});

describe("#780 R3 - the refusal that already exists for a shell target, pinned", () => {
  function planAgainst(path: string): ExecutionPlan {
    return {
      storyId: 780,
      title: "Add a footer credit line",
      summary: "Add one line to the footer.",
      targetFiles: [{ path, action: "modify", rationale: "where the story points" }],
      acceptanceCriteriaMap: [
        { acId: "AC1", description: "the line renders", testFile: "src/App.test.jsx", testCaseName: "renders the line" },
      ],
    } as ExecutionPlan;
  }

  const CONTEXT = {
    surface: { route: "/", page: NAMED_SURFACE },
    roles: { [SHELL]: { role: "shell" as const, evidence: "renders on every route" } },
  };

  it("refuses a page-scoped story planned against the shell", () => {
    expect(isPageScopedStory(STORY)).toBe(true);

    const result = validateExecutionPlan(planAgainst(SHELL), STORY, CONTEXT);

    expect(result.valid).toBe(false);
    expect(result.codes ?? []).toContain("target-role");
  });

  it("names the page to use instead, because a bare 'wrong target' only re-guesses", () => {
    const result = validateExecutionPlan(planAgainst(SHELL), STORY, CONTEXT);

    expect(result.errors.join(" ")).toContain(NAMED_SURFACE);
  });
});
