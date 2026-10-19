import { describe, expect, it } from "vitest";
import {
  validateExecutionPlan,
  type ExecutionPlan,
  type PlanValidationContext,
} from "../../agent/lib/dark-factory/plan-validator";

/**
 * #381 R2 AC3 - a page-scoped story may not be planned against the shell or a shared component.
 *
 * The fixture is the WebFeedPOC shape that failed twice: `src/App.jsx` renders an outlet (shell),
 * `src/components/ProductList.jsx` is composed by two pages (shared), and `src/pages/HomePage.jsx` is the
 * page the story actually means.
 */
const STORY = [
  "Change the heading on the main page.",
  "",
  "**Acceptance Criteria**",
  "- AC1: the important heading reads Hello",
].join("\n");

/** A story about something on every route: the shell is the RIGHT target here. */
const SHELL_STORY = [
  "Add a footer on every page.",
  "",
  "**Acceptance Criteria**",
  "- AC1: the footer appears",
].join("\n");

const ROLES: NonNullable<PlanValidationContext["roles"]> = {
  "src/App.jsx": {
    role: "shell",
    evidence: "renders an outlet, so it is rendered on every route",
  },
  "src/components/ProductList.jsx": {
    role: "shared",
    evidence: "reached from src/pages/HomePage.jsx, src/pages/CategoryPage.jsx",
  },
  "src/pages/HomePage.jsx": {
    role: "page",
    evidence: 'route "/" -> src/pages/HomePage.jsx',
  },
};

const SURFACE = { route: "/", page: "src/pages/HomePage.jsx" };

function planTargeting(path: string): ExecutionPlan {
  return {
    storyId: 166,
    title: "Change the heading on the main page",
    summary: "Move the heading",
    targetFiles: [
      { path, action: "modify", rationale: "the surface the story means" },
    ],
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "the important heading reads Hello",
        testFile: "tests/homepage.test.tsx",
        testCaseName: "renders Hello",
      },
    ],
  };
}

describe("target roles (#381 R2 AC3)", () => {
  it("REFUSES the application shell for a page-scoped story", () => {
    const result = validateExecutionPlan(planTargeting("src/App.jsx"), STORY, {
      roles: ROLES,
      surface: SURFACE,
    });

    expect(result.valid).toBe(false);
    const message = result.errors.join("\n");
    expect(message).toContain("src/App.jsx");
    // The reason must say WHY it is wrong, not merely that it is.
    expect(message).toMatch(/every route|shell/i);
    // And it must name the page the plan should have used, so the repair round has something to act on.
    expect(message).toContain("src/pages/HomePage.jsx");
  });

  it("REFUSES a SHARED component for a page-scoped story, citing the pages that prove it", () => {
    const result = validateExecutionPlan(
      planTargeting("src/components/ProductList.jsx"),
      STORY,
      {
        roles: ROLES,
        surface: SURFACE,
      },
    );

    expect(result.valid).toBe(false);
    const message = result.errors.join("\n");
    expect(message).toContain("src/components/ProductList.jsx");
    expect(message).toMatch(/shared/i);
  });

  it("ACCEPTS the page the story names", () => {
    const result = validateExecutionPlan(
      planTargeting("src/pages/HomePage.jsx"),
      STORY,
      {
        roles: ROLES,
        surface: SURFACE,
      },
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("ACCEPTS the shell when the story is about every page", () => {
    // The false-positive guard. If this failed, R2 would block legitimate shell changes.
    const result = validateExecutionPlan(
      planTargeting("src/App.jsx"),
      SHELL_STORY,
      {
        roles: ROLES,
        surface: SURFACE,
      },
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("changes nothing when no roles are supplied", () => {
    // Backward compatibility: every existing caller passes no context.
    const result = validateExecutionPlan(planTargeting("src/App.jsx"), STORY);
    expect(result.valid).toBe(true);
  });

  it("changes nothing for a story that is not about a surface", () => {
    const backendStory = [
      "Fix the retry count in the lease reaper.",
      "",
      "**Acceptance Criteria**",
      "- AC1: the retry count is bounded",
    ].join("\n");
    const plan = planTargeting("src/components/ProductList.jsx");
    plan.acceptanceCriteriaMap[0].description = "the retry count is bounded";

    // A shared module is a legitimate backend target; the rule is about UI scope, not about sharing.
    expect(
      validateExecutionPlan(plan, backendStory, { roles: ROLES }).valid,
    ).toBe(true);
  });
});
