import { describe, expect, it } from "vitest";
import { acTestFileUnresolvable, validateExecutionPlan, type ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #785 - a plan can map an acceptance criterion to a test file it will neither write nor find.
 *
 * Found by R4's measurement (#781) on the second of two runs of an identical story: that plan named
 * `src/App.test.jsx` in its acceptance-criteria map while its `targetFiles` was `src/App.jsx` alone.
 *
 * The rule is deliberately the PRECISE form - resolved by the target set OR by the repository - and not the stricter
 * "must be in targetFiles". Reusing an existing suite to cover a criterion is correct behaviour, and a rule that
 * refuses correct plans is the one that gets worked around.
 */
const TARGETS = ["src/components/ProductGrid.jsx"];

describe("#785 - an unresolvable AC test file is reported", () => {
  it("reports a mapping whose test file is neither written nor present", () => {
    expect(
      acTestFileUnresolvable({ testFile: "src/ProductGrid.test.jsx", targetPaths: TARGETS, knownFiles: [] }),
    ).toBe(true);
  });

  it("reports it when other files exist but not that one", () => {
    expect(
      acTestFileUnresolvable({
        testFile: "src/ProductGrid.test.jsx",
        targetPaths: TARGETS,
        knownFiles: ["src/App.jsx", "src/main.jsx"],
      }),
    ).toBe(true);
  });
});

describe("#785 - the controls, so this is a guard and not a wall", () => {
  it("CONTROL: a test file the plan will WRITE is resolved by the target set", () => {
    expect(
      acTestFileUnresolvable({
        testFile: "src/components/ProductGrid.jsx",
        targetPaths: TARGETS,
        knownFiles: [],
      }),
    ).toBe(false);
  });

  it("CONTROL: an EXISTING suite the plan reuses is resolved by the repository, though it is not a target", () => {
    // The case the stricter rule would have broken, and the reason the rule is written this way.
    expect(
      acTestFileUnresolvable({
        testFile: "src/App.test.jsx",
        targetPaths: TARGETS,
        knownFiles: ["src/App.test.jsx"],
      }),
    ).toBe(false);
  });

  it("CONTROL: an UNKNOWN repository is not reported", () => {
    // `undefined` means "no file list was supplied", which is not the same as "the repository is empty". Refusing on
    // unknown information would refuse plans for a reason they cannot act on - the same distinction R3 makes for a
    // named surface, and the reason an EMPTY list below is treated differently.
    expect(
      acTestFileUnresolvable({ testFile: "src/ProductGrid.test.jsx", targetPaths: TARGETS }),
    ).toBe(false);
    expect(
      acTestFileUnresolvable({ testFile: "src/ProductGrid.test.jsx", targetPaths: TARGETS, knownFiles: null }),
    ).toBe(false);
  });

  it("CONTROL: an EMPTY repository list IS a statement, so it does report", () => {
    // Guarded here because the two cases above look alike and mean opposite things.
    expect(
      acTestFileUnresolvable({ testFile: "src/ProductGrid.test.jsx", targetPaths: TARGETS, knownFiles: [] }),
    ).toBe(true);
  });

  it("CONTROL: a path spelled with a leading ./ is still resolved", () => {
    expect(
      acTestFileUnresolvable({ testFile: "./src/App.test.jsx", targetPaths: TARGETS, knownFiles: ["src/App.test.jsx"] }),
    ).toBe(false);
  });
});

describe("#785 - the validator reaches the rule", () => {
  const STORY = "On the home page, show a grid of products with the price of each one.";
  const CONTEXT = { surface: { route: "/", page: "src/pages/HomePage.jsx" }, roles: {}, files: [] as string[] };

  function plan(mappingTestFile: string, targets: string[]): ExecutionPlan {
    return {
      storyId: 785,
      title: "Show a product grid",
      summary: "Add the grid.",
      targetFiles: targets.map((path) => ({ path, action: "modify", rationale: "where the grid lives" })),
      acceptanceCriteriaMap: [
        {
          acId: "AC1",
          description: "the grid renders prices",
          testFile: mappingTestFile,
          testCaseName: "renders the grid with prices",
        },
      ],
    } as ExecutionPlan;
  }

  it("refuses a plan whose mapping points at a file it cannot deliver, naming the file", () => {
    const result = validateExecutionPlan(plan("src/ProductGrid.test.jsx", TARGETS), STORY, CONTEXT);

    expect(result.valid).toBe(false);
    expect(result.codes ?? []).toContain("ac-test-file-outside-targets");
    // Actionable, because a repair round told only "invalid mapping" simply re-guesses.
    expect(result.errors.join(" ")).toContain("src/ProductGrid.test.jsx");
  });

  it("CONTROL: the same plan with the test file in its target set is not refused on this code", () => {
    const result = validateExecutionPlan(
      plan("src/ProductGrid.test.jsx", [...TARGETS, "src/ProductGrid.test.jsx"]),
      STORY,
      CONTEXT,
    );

    expect(result.codes ?? []).not.toContain("ac-test-file-outside-targets");
  });
});
