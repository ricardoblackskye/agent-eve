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
