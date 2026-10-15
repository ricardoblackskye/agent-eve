import { describe, expect, it } from "vitest";
import { renderPlanFile, type PlanFileInput } from "../../agent/lib/dark-factory/plan-file";

/**
 * #361 Task 9 — the plan must be renderable as a file.
 *
 * The Factory planned in memory only, so a failed run left no record of its intent. The output is also
 * linted by MegaLinter as changed markdown, so the renderer has to emit markdown that passes: MD040
 * (fenced blocks carry a language), MD024 (no duplicate headings) and MD026 (headings do not end in
 * punctuation). Those are asserted here, not assumed.
 */
describe("renderPlanFile", () => {
  const base: PlanFileInput = {
    storyId: 361,
    title: "Keep the coding loop from overwriting working code",
    summary: "Refuse a change that would delete most of a file it was only asked to modify.",
    approach: "Read the file before writing it, and compare what is kept against what is removed.",
    tasks: [
      {
        title: "Preservation guard",
        objective: "Refuse a destructive rewrite of a modify target.",
        files: ["agent/lib/dark-factory/preservation-guard.ts"],
        steps: ["Measure the lines removed.", "Refuse past the threshold."],
        verification: "tests/dark-factory/preservation-guard.test.ts",
      },
      {
        title: "Stage what ran",
        objective: "Commit the files the loop actually wrote.",
        files: ["scripts/dark-factory-runner.ts"],
        verification: "tests/dark-factory/run-files-to-commit.test.ts",
      },
    ],
    targetFiles: [
      {
        path: "app/chat.tsx",
        action: "modify",
        rationale: "Add the bold welcome line below the icon.",
      },
    ],
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "working code survives",
        testFile: "tests/dark-factory/runner-authoring.test.ts",
        testCaseName: "preserves the content already on disk",
      },
    ],
    risks: ["A legitimately large rewrite must declare `replace` in the plan."],
    dependencies: ["#352"],
  };

  it("renders the title and the goal", () => {
    const md = renderPlanFile(base);
    expect(md).toMatch(/^# Plan: Keep the coding loop from overwriting working code/m);
    expect(md).toContain("Refuse a change that would delete most of a file");
  });

  it("renders the approach when the plan has one, and omits the section when it does not", () => {
    expect(renderPlanFile(base)).toContain("## Approach");
    const withoutApproach: PlanFileInput = { ...base, approach: undefined };
    expect(renderPlanFile(withoutApproach)).not.toContain("## Approach");
  });

  it("numbers the tasks, with their steps and verification", () => {
    const md = renderPlanFile(base);
    expect(md).toContain("### 1. Preservation guard");
    expect(md).toContain("### 2. Stage what ran");
    expect(md).toContain("Measure the lines removed.");
    expect(md).toContain("tests/dark-factory/preservation-guard.test.ts");
  });

  it("omits the tasks section entirely when the plan has none", () => {
    const md = renderPlanFile({ ...base, tasks: undefined });
    expect(md).not.toContain("## Tasks");
  });

  it("lists the target files with their action and rationale", () => {
    const md = renderPlanFile(base);
    expect(md).toContain("## Files to change");
    expect(md).toContain("`app/chat.tsx`");
    expect(md).toContain("modify");
    expect(md).toContain("Add the bold welcome line below the icon.");
  });

  it("renders the acceptance criteria and the risks", () => {
    const md = renderPlanFile(base);
    expect(md).toContain("AC1");
    expect(md).toContain("## Risks");
    expect(md).toContain("must declare `replace` in the plan");
  });

  // --- the lint constraints, asserted rather than trusted --------------------

  it("gives every fenced block a language, so markdownlint MD040 passes", () => {
    // A model-authored approach can carry a fence with no info string; the generated file would then
    // fail MD040 in the pull request's MegaLinter run.
    const fence = "```";
    const md = renderPlanFile({
      ...base,
      approach: `Here is the shape:\n${fence}\nconst a = 1;\n${fence}\nThat is all.`,
    });
    const openers = md.split("\n").filter((l) => l.trim().startsWith("```") && l.trim() !== "```");
    expect(openers.length).toBeGreaterThan(0);
    // No line may open a fence without an info string.
    const bare = md.split("\n").filter((l) => l.trim() === "```");
    // Any remaining bare fence must be a CLOSER, so bare fences can never outnumber openers.
    expect(bare.length).toBeLessThanOrEqual(openers.length);
    expect(md).toContain("```text");
  });

  it("does not end a heading in punctuation, so markdownlint MD026 passes", () => {
    const md = renderPlanFile({
      ...base,
      tasks: [{ title: "Guard the rewrite:", objective: "Refuse it." }],
    });
    for (const line of md.split("\n")) {
      if (line.startsWith("#")) {
        expect(line.trimEnd()).not.toMatch(/[.,;:!?]$/);
      }
    }
  });

  it("keeps two tasks with the same title distinct, so markdownlint MD024 passes", () => {
    const md = renderPlanFile({
      ...base,
      tasks: [
        { title: "Harden the guard", objective: "First pass." },
        { title: "Harden the guard", objective: "Second pass." },
      ],
    });
    const headings = md.split("\n").filter((l) => l.startsWith("### "));
    expect(headings).toHaveLength(2);
    expect(new Set(headings).size).toBe(2);
  });

  it("escapes a pipe in table text, so the table does not break", () => {
    const md = renderPlanFile({
      ...base,
      targetFiles: [
        { path: "a.ts", action: "modify", rationale: "support a|b alternation" },
      ],
    });
    expect(md).toContain("a\\|b");
  });

  it("links the issue when one is given", () => {
    const md = renderPlanFile(base, {
      issueUrl: "https://github.com/ricardoblackskye/agent-eve/issues/361",
    });
    expect(md).toContain("https://github.com/ricardoblackskye/agent-eve/issues/361");
  });

  // --- found by running the REAL linter over real output, not by reasoning about rules -----
  //
  // markdownlint over a rendered plan reported MD034 and MD013, which the first version missed. Both
  // are asserted now, because the factory's own pull request is linted.

  it("never emits a bare URL, so markdownlint MD034 passes", () => {
    const md = renderPlanFile(base, {
      issueUrl: "https://github.com/ricardoblackskye/agent-eve/issues/361",
    });
    for (const line of md.split("\n")) {
      // Remove markdown link targets and autolinks; no URL may remain bare in the prose.
      const bare = line.replace(/\]\([^)]*\)/g, "").replace(/<[^>]*>/g, "");
      expect(bare).not.toMatch(/https?:\/\//);
    }
  });

  it("silences only the line-length rule, which arbitrary generated content cannot satisfy", () => {
    // MD013 (80 columns) cannot be met for model-authored prose and table cells that must not be
    // wrapped. This repository silences it exactly the same way in its own generated catalogue
    // (docs/pages/dark-factory-modules.md), so the generated plan follows that precedent rather than
    // inventing a different one. The rules this renderer CAN satisfy stay enabled.
    const md = renderPlanFile(base);
    const firstLine = md.split("\n")[0];
    expect(firstLine).toContain("markdownlint-disable");
    expect(firstLine).toContain("MD013");
    // MD040/MD024/MD026 must NOT be silenced by that comment.
    expect(firstLine).not.toContain("MD040");
    expect(firstLine).not.toContain("MD024");
    expect(firstLine).not.toContain("MD026");
  });
});
