import { describe, expect, it } from "vitest";
import { renderPlanFile, type PlanFileInput } from "../../agent/lib/dark-factory/plan-file";

/**
 * #503 — the STEP 5 crash.
 *
 * The architect's RETURNED plan used a different vocabulary for `targetFiles` than the renderer reads:
 * `{ path, changeType, reason }` instead of `{ path, action, rationale }`. The renderer called
 * `cell(file.action)` / `cell(file.rationale)` on `undefined`, and `cell`/`headingText` both start with
 * `text.replace(...)` — so the run died with "Cannot read properties of undefined (reading 'replace')"
 * before it could post the plan comment. This is the real-bug anchor: it must fail on the pre-fix code
 * for exactly that reason, not as a blanket defensive change.
 *
 * The runtime shape is not type-checked (model output), so we cast to the declared type to exercise the
 * actual deserialized payload.
 */
describe("renderPlanFile with the architect's renamed targetFiles vocabulary (#503)", () => {
  const malformed = {
    storyId: 173,
    title: "Add a 'Welcome to the site' sub-heading",
    summary: "Add a bold sub-heading to the main page.",
    approach: undefined,
    tasks: [
      {
        title: "Add the sub-heading",
        objective: "Render a bold 'Welcome to the site' line on the home page.",
        files: ["src/pages/HomePage.jsx"],
        steps: ["Insert the heading below the hero."],
        verification: "tests/dark-factory/home-page.test.tsx",
      },
    ],
    // NOTE: deliberately uses changeType/reason, NOT action/rationale — the crash shape.
    targetFiles: [
      {
        path: "src/pages/HomePage.jsx",
        changeType: "modify",
        reason: "Route '/' renders HomePage inside the App outlet.",
      },
    ],
    acceptanceCriteriaMap: [],
    risks: [],
    dependencies: [],
  } as unknown as PlanFileInput;

  it("does NOT throw on targetFiles missing action/rationale (the crash shape)", () => {
    // Pre-fix this throws: Cannot read properties of undefined (reading 'replace').
    expect(() => renderPlanFile(malformed)).not.toThrow();
  });

  it("returns a string and still renders the file path", () => {
    const md = renderPlanFile(malformed);
    expect(typeof md).toBe("string");
    expect(md).toContain("src/pages/HomePage.jsx");
  });

  it("renders a visible marker for the missing cells instead of 'undefined'", () => {
    const md = renderPlanFile(malformed);
    expect(md).not.toContain("undefined");
    // The "Files to change" table row must carry a non-empty placeholder in the action/rationale cells.
    expect(md).toMatch(/\|[^|]*\|[^|]*—[^|]*\|[^|]*—[^|]*\|/);
  });
});
