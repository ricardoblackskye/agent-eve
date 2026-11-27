import { describe, expect, it } from "vitest";
import { pathsOutsideApprovedSet } from "../../agent/lib/dark-factory/approved-target-set";

/**
 * #763 R2 — the approved plan's `targetFiles` is a CONTRACT, and what the run writes must be a subset of it.
 *
 * One live escape proved it is not enforced: a fix cycle wrote a file outside its plan's approved target set (a CI
 * workflow) and nothing objected. The issue's direction of safety is explicit — prefer refusing to routing around an
 * obstacle — so the check exists to make the approval mean something, not to be worked around.
 *
 * The rule is provider- and repo-agnostic by construction: it asks only whether a path is in the approved set. It
 * names no vendor, repository, framework or surface kind, which is an acceptance criterion of the issue.
 */
const PLAN = {
  targetFiles: [{ path: "src/App.jsx" }, { path: "src/App.test.jsx" }],
};

describe("#763 R2 - the run stays inside the approved target set", () => {
  it("names an authored path that is outside the approved set", () => {
    const outside = pathsOutsideApprovedSet(["src/App.jsx", ".github/workflows/e2e.yml"], PLAN);

    // The escape that happened in practice: a CI workflow written by a fix cycle, outside the approved set.
    expect(outside).toEqual([".github/workflows/e2e.yml"]);
  });

  it("names EVERY outside path, not just the first", () => {
    const outside = pathsOutsideApprovedSet(
      ["src/App.jsx", ".github/workflows/e2e.yml", "docs/README.md"],
      PLAN,
    );

    expect(outside).toEqual([".github/workflows/e2e.yml", "docs/README.md"]);
  });

  it("CONTROL: a run that stays inside the set reports nothing", () => {
    // Without this, "report everything as a violation" would satisfy the cases above.
    const outside = pathsOutsideApprovedSet(["src/App.jsx", "src/App.test.jsx"], PLAN);

    expect(outside).toEqual([]);
  });

  it("CONTROL: a plan that approved NOTHING authorizes nothing", () => {
    // Fail closed: a plan without targets cannot license a write, so every authored path is outside it.
    const outside = pathsOutsideApprovedSet(["src/App.jsx"], { targetFiles: [] });

    expect(outside).toEqual(["src/App.jsx"]);
  });

  it("CONTROL: a missing target list is the same as none, and does not throw", () => {
    // The plan shape is typed as required but a deserialized plan may omit it, which is exactly the TypeError the
    // recording layer hit before (#503 AC4). A guard must not depend on another guard to avoid crashing.
    const outside = pathsOutsideApprovedSet(["src/App.jsx"], {});

    expect(outside).toEqual(["src/App.jsx"]);
  });

  it("treats a path written with a different separator or a leading ./ as the SAME path", () => {
    // `.\\src\\App.jsx` and `./src/App.jsx` are the approved file, not a violation - a false positive here would
    // refuse legitimate runs, which is how a guard gets worked around instead of respected.
    expect(pathsOutsideApprovedSet(["./src/App.jsx"], PLAN)).toEqual([]);
    expect(pathsOutsideApprovedSet([".\\src\\App.jsx"], PLAN)).toEqual([]);
    expect(pathsOutsideApprovedSet(["  src/App.jsx  "], PLAN)).toEqual([]);
  });

  it("reports each outside path ONCE, however many times it was written", () => {
    const outside = pathsOutsideApprovedSet(
      ["docs/README.md", "docs/README.md", "docs/README.md"],
      PLAN,
    );

    expect(outside).toEqual(["docs/README.md"]);
  });
});
