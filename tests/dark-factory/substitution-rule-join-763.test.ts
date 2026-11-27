import { describe, expect, it } from "vitest";
import { isPageScopedStory, validateExecutionPlan, type ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #780 (R3) - the JOIN: the rule runs, through the real validator.
 *
 * `substitution-declaration-763.test.ts` proves the rule's behaviour in isolation. This proves the rule is actually
 * REACHED by `validateExecutionPlan` - because a correct rule that nothing calls is exactly how the existence check
 * in #770 came to be a rule that could not fire, and how a wiring guard passed while the file did not compile (#704).
 *
 * Isolation from the neighboring rules matters as much as the assertion:
 * - the target chosen here has NO known role, so the target-role rule (3b) skips it - otherwise a refusal could come
 *   from 3b and this test would pass without R3's rule existing at all;
 * - the declaration cases are compared only on the R3 code, never on `valid` alone, for the same reason.
 */
const STORY = "On the home page, show a grid of products with the price of each one.";
const NAMED_SURFACE = "src/pages/HomePage.jsx";
/** Not a shell and not shared, and absent from `roles`, so rule 3b has nothing to say about it. */
const PLAIN_TARGET = "src/components/FooterCredit.jsx";

function planWith(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    storyId: 780,
    title: "Add a footer credit line",
    summary: "Add one line to the footer.",
    targetFiles: [{ path: PLAIN_TARGET, action: "modify", rationale: "the footer is composed here" }],
    acceptanceCriteriaMap: AC_MAP,
    ...overrides,
  } as ExecutionPlan;
}

/** Non-empty on purpose: an empty map is refused by the #502 check, which would refuse the plan BEFORE the rule
 * under test is ever reached - the failure mode that made the first attempt at this file report nothing useful. */
const AC_MAP = [
  {
    acId: "AC1",
    description: "the grid renders the price of each product",
    testFile: "src/App.test.jsx",
    testCaseName: "renders the product grid with prices",
  },
];

const CONTEXT = { surface: { route: "/", page: NAMED_SURFACE }, roles: {} };

describe("#780 R3 - the validator reaches the rule", () => {
  it("PRECONDITION: the story really is page-scoped, so the cases below cannot pass vacuously", () => {
    // If this fails, every assertion below is meaningless rather than green: they assert the ABSENCE of a code, and
    // a rule that never fires also never fires the code. This is the anti-vacuity check the first attempt lacked.
    expect(isPageScopedStory(STORY)).toBe(true);
  });

  it("refuses a plan that substitutes without declaring it, and says so in codes", () => {
    const result = validateExecutionPlan(planWith(), STORY, CONTEXT);

    expect(result.valid).toBe(false);
    expect(result.codes ?? [], `validator errors were: ${JSON.stringify(result.errors)}`).toContain("undeclared-substitution");
  });

  it("CONTROL: the same plan WITH the declaration is not refused on the R3 code", () => {
    // Without this, the case above would pass even if the rule refused every plan that omits the named surface.
    const result = validateExecutionPlan(
      planWith({
        substitution: { chosen: PLAIN_TARGET, named: NAMED_SURFACE, reason: "the footer is composed elsewhere" },
      }),
      STORY,
      CONTEXT,
    );

    expect(result.codes ?? []).not.toContain("undeclared-substitution");
  });

  it("CONTROL: targeting the named surface is never refused on the R3 code", () => {
    const result = validateExecutionPlan(
      planWith({ targetFiles: [{ path: NAMED_SURFACE, action: "modify", rationale: "the story names this surface" }] }),
      STORY,
      CONTEXT,
    );

    expect(result.codes ?? []).not.toContain("undeclared-substitution");
  });

  it("CONTROL: with no known named surface the rule stays silent", () => {
    // The narrowness, asserted through the public entry point rather than only at the helper.
    const result = validateExecutionPlan(planWith(), STORY, { surface: {}, roles: {} });

    expect(result.codes ?? []).not.toContain("undeclared-substitution");
  });
});
