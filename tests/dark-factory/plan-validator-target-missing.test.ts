import { describe, expect, it } from "vitest";
import {
  validateExecutionPlan,
  type ExecutionPlan,
} from "../../agent/lib/dark-factory/plan-validator";

/**
 * #381 R2 Task 8 - a target that does not exist in the repository is a validation error.
 *
 * The live run produced `src/components/Header.js`, `src/components/Footer.js`, `src/App.js`,
 * `src/App.test.js` and `src/index.js` for a repository containing none of them - and the failure the
 * model was told about was a missing `action` field, not the far more important fact that the files do
 * not exist. Existence is mechanical, so it belongs here rather than in the prompt alone.
 *
 * Backward compatibility is part of the contract: with no file list supplied the validator behaves
 * exactly as it did, which is the property every existing caller depends on.
 */
const FILES = ["src/App.jsx", "src/main.jsx", "src/pages/HomePage.jsx"];

/**
 * The file list measured on the repository where the defect actually happened, so the #770 case below reproduces
 * the live shape rather than an approximation of it.
 */
const LIVE_FILES = [...FILES, "src/App.test.jsx"];

function plan(...paths: string[]): ExecutionPlan {
  return {
    storyId: 169,
    title: "Dark Factory Test Issue 7 (sandbox)",
    summary: "Add a sub-heading to the main page",
    targetFiles: paths.map((path) => ({
      path,
      action: "modify" as const,
      rationale: "the surface the story means",
    })),
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "the sub-heading reads Welcome to the site",
        testFile: "tests/homepage.test.tsx",
        testCaseName: "renders Welcome to the site",
      },
    ],
  };
}

/** Shared by the #454 and #770 blocks: the same plan, with the action left to the caller. */
function planWithActions(
  targets: Array<{ path: string; action: "create" | "modify" | "replace" }>,
): ExecutionPlan {
  return {
    storyId: 169,
    title: "Dark Factory Test Issue 7 (sandbox)",
    summary: "Add a sub-heading to the main page",
    targetFiles: targets.map((t) => ({
      ...t,
      rationale: "the surface the story means",
    })),
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "the sub-heading reads Welcome to the site",
        testFile: "tests/homepage.test.tsx",
        testCaseName: "renders Welcome to the site",
      },
    ],
  };
}

describe("#381 R2 Task 8 - target files must exist in the repository", () => {
  it("rejects a target path that is not in the repository", () => {
    const result = validateExecutionPlan(
      plan("src/components/Header.js"),
      "add a sub-heading on the main page",
      { files: FILES },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("src/components/Header.js");
    expect(result.codes).toContain("target-missing");
  });

  it("names EVERY invented path, not just the first", () => {
    const result = validateExecutionPlan(
      plan("src/components/Header.js", "src/index.js", "src/pages/HomePage.jsx"),
      "add a sub-heading on the main page",
      { files: FILES },
    );

    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("src/components/Header.js");
    expect(result.errors.join(" ")).toContain("src/index.js");
    // The real file is not an error: the message must be precise enough to act on.
    expect(result.errors.join(" ")).not.toContain("'src/pages/HomePage.jsx'");
  });

  it("accepts a plan whose targets all exist", () => {
    const result = validateExecutionPlan(
      plan("src/pages/HomePage.jsx"),
      "add a sub-heading on the main page",
      { files: FILES },
    );

    expect(result.valid).toBe(true);
    expect(result.codes ?? []).not.toContain("target-missing");
  });

  it("behaves exactly as before when no file list is supplied", () => {
    const result = validateExecutionPlan(
      plan("src/components/Header.js"),
      "add a sub-heading on the main page",
    );

    expect(result.valid).toBe(true);
  });
});

describe("issue #454 - a create target is allowed not to exist", () => {
  it("accepts a create target that is absent from the file list", () => {
    const result = validateExecutionPlan(
      planWithActions([{ path: "src/pages/HomePage.test.jsx", action: "create" }]),
      "add a sub-heading on the main page",
      { files: FILES },
    );

    expect(result.valid).toBe(true);
    expect(result.codes ?? []).not.toContain("target-missing");
  });

  it("accepts a mixed plan: existing modify + absent create", () => {
    const result = validateExecutionPlan(
      planWithActions([
        { path: "src/pages/HomePage.jsx", action: "modify" },
        { path: "src/pages/HomePage.test.jsx", action: "create" },
      ]),
      "add a sub-heading on the main page",
      { files: FILES },
    );

    expect(result.valid).toBe(true);
    expect(result.codes ?? []).not.toContain("target-missing");
  });

  it("still rejects a modify target that is absent", () => {
    const result = validateExecutionPlan(
      planWithActions([{ path: "src/pages/HomePage.test.jsx", action: "modify" }]),
      "add a sub-heading on the main page",
      { files: FILES },
    );

    expect(result.valid).toBe(false);
    expect(result.codes).toContain("target-missing");
  });
});

/**
 * #770 - a `create` target that ALREADY EXISTS is the inverse error, and it is the one that actually occurred.
 *
 * #381 R2 Task 8 checks that a `modify` target is present. The `create` branch `continue`s before that check, on
 * the reasoning that a create target is DEFINED as non-existent - so the one case that has gone wrong in practice
 * was never compared against reality, and the validator compared the plan to itself.
 *
 * Measured three times in one afternoon: `WebFeedPOC#269` and `#271` both planned `create src/App.test.jsx` for a
 * file present with 340 lines, and both runs printed `-> Domain Validation Passed!`. On #271 the plan feedback
 * saying so was posted and verified BEFORE the resume, and the action still did not change - so the conversational
 * path is not the remedy and this rule is.
 *
 * The controls that keep this from over-refusing are the #454 cases above: a create target that is genuinely
 * ABSENT must still be accepted, or the fix would block every legitimate new file.
 */
describe("issue #770 - a create target that already exists is refused", () => {
  it("rejects a create target that is present in the file list", () => {
    const result = validateExecutionPlan(
      planWithActions([{ path: "src/App.jsx", action: "create" }]),
      "add a sub-heading on the main page",
      { files: FILES },
    );

    expect(result.valid).toBe(false);
    expect(result.codes).toContain("target-exists");
    // The refusal must be actionable rather than merely negative: name the file, and say what to do instead.
    expect(result.errors.join(" ")).toContain("src/App.jsx");
    expect(result.errors.join(" ")).toMatch(/modify/i);
  });

  it("rejects the live shape: #271's own targetFiles, replayed against that repository's file list", () => {
    const result = validateExecutionPlan(
      planWithActions([
        { path: "src/App.jsx", action: "modify" },
        { path: "src/App.test.jsx", action: "create" },
      ]),
      "add a footer line next to the copyright text",
      { files: LIVE_FILES },
    );

    expect(result.valid).toBe(false);
    expect(result.codes).toContain("target-exists");
    expect(result.errors.join(" ")).toContain("src/App.test.jsx");
  });
});
