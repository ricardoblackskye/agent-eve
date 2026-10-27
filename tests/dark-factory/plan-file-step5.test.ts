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

/**
 * #503 Task 4 — the SAME crash class, at every other field the renderer emits.
 *
 * Making only `cell`/`headingText` total fixed the first throw, and the very next real run died at
 * `risk.trim is not a function`: the architect returned `risks` as `{risk, mitigation}` pairs while
 * `PlanFileInput` declares `string[]`. The renderer's other seven fields (`summary`, `approach`,
 * `objective`, `steps`, `verification`, `risks`, `dependencies`) are all declared as strings and all
 * call `.trim()` directly, so each one is the same latent crash one step later.
 *
 * These tests drive the real renderer with the payload the model actually returned, so they fail on the
 * pre-fix code for the same reason the run did — a TypeError on a non-string field — rather than as a
 * blanket "make it defensive" change.
 */
describe("renderPlanFile is total across every emitted field (#503 Task 4)", () => {
  const base = {
    storyId: 173,
    title: "Add a 'Welcome to the site' sub-heading",
    summary: "Add a bold sub-heading to the main page.",
    targetFiles: [
      { path: "src/pages/HomePage.jsx", action: "modify", rationale: "The '/' route." },
    ],
  };

  it("renders {risk, mitigation} pairs without throwing (the second real crash)", () => {
    const plan = {
      ...base,
      risks: [
        {
          risk: "A conditional block would hide the heading in some states.",
          mitigation: "Insert it unconditionally as the first child.",
        },
      ],
    } as unknown as PlanFileInput;

    // Pre-fix: TypeError: risk.trim is not a function.
    expect(() => renderPlanFile(plan)).not.toThrow();
    const md = renderPlanFile(plan);
    expect(md).toContain("A conditional block would hide the heading");
    // The mitigation is not silently dropped — a reviewer needs it.
    expect(md).toContain("Insert it unconditionally as the first child");
    expect(md).not.toContain("[object Object]");
    expect(md).not.toContain("undefined");
  });

  it("renders a mixed risks array of strings and pairs", () => {
    const plan = {
      ...base,
      risks: ["A plain string risk.", { risk: "A pair risk.", mitigation: "Pair mitigation." }],
    } as unknown as PlanFileInput;

    expect(() => renderPlanFile(plan)).not.toThrow();
    const md = renderPlanFile(plan);
    expect(md).toContain("A plain string risk.");
    expect(md).toContain("A pair risk.");
    expect(md).toContain("Pair mitigation.");
  });

  it("does not throw when summary/approach arrive as non-strings", () => {
    const plan = {
      ...base,
      summary: { text: "a summary object, not a string" },
      approach: { text: "an approach object" },
    } as unknown as PlanFileInput;

    // Pre-fix: TypeError on summary.trim().
    expect(() => renderPlanFile(plan)).not.toThrow();
    expect(renderPlanFile(plan)).not.toContain("[object Object]");
  });

  it("does not throw when task objective/steps/verification arrive as non-strings", () => {
    const plan = {
      ...base,
      tasks: [
        {
          title: "A task",
          objective: { text: "objective object" },
          steps: ["a real step", { text: "step object" }],
          verification: { text: "verification object" },
        },
      ],
    } as unknown as PlanFileInput;

    expect(() => renderPlanFile(plan)).not.toThrow();
    const md = renderPlanFile(plan);
    expect(md).toContain("a real step");
    expect(md).not.toContain("[object Object]");
  });

  it("does not throw when dependencies arrive as non-strings", () => {
    const plan = {
      ...base,
      dependencies: ["#501", { id: "#502" }],
    } as unknown as PlanFileInput;

    expect(() => renderPlanFile(plan)).not.toThrow();
    expect(renderPlanFile(plan)).not.toContain("[object Object]");
  });

  it("still renders a well-formed plan unchanged (no regression)", () => {
    const md = renderPlanFile({
      ...base,
      summary: "Add a bold sub-heading to the main page.",
      approach: "Insert the heading below the hero.",
      tasks: [
        {
          title: "Add the sub-heading",
          objective: "Render a bold line.",
          files: ["src/pages/HomePage.jsx"],
          steps: ["Insert the heading."],
          verification: "tests/home-page.test.tsx",
        },
      ],
      risks: ["Plain risk."],
      dependencies: ["#501"],
    } as unknown as PlanFileInput);

    expect(md).toContain("## Goal");
    expect(md).toContain("## Approach");
    expect(md).toContain("## Risks");
    expect(md).toContain("- Plain risk.");
    expect(md).toContain("- #501");
    expect(md).not.toContain("undefined");
  });
});
