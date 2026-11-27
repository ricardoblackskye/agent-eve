import { describe, expect, it } from "vitest";
import { renderPlanFile, renderScopeReading } from "../../agent/lib/dark-factory/plan-file";

/**
 * #784 - the plan must state the classification its target choice rests on.
 *
 * The worked example is R4's runs, and the three before them: every one targeted the application shell for a story
 * that says "the home page", and every one passed validation. They were CORRECT - a footer credit reads as
 * shell-scoped work - but nothing in the plan said so. An approver could not tell "the shell is right because this
 * story reads as shell-scoped" from "the plan picked the shell by accident", and those demand different responses.
 *
 * The reading is rendered from the same two exported classifiers the validator acts on, so the plan cannot state a
 * reading the rules disagreed with.
 */
const SHELL = { shellScoped: true, pageScoped: false };
const PAGE = { shellScoped: false, pageScoped: true };
const NEITHER = { shellScoped: false, pageScoped: false };

const PLAN = {
  storyId: 784,
  title: "Add a footer credit line",
  summary: "Add the credit line.",
  targetFiles: [{ path: "src/App.jsx", action: "modify", rationale: "the shell renders the footer" }],
  acceptanceCriteriaMap: [],
};

describe("#784 - the reading is rendered for each case", () => {
  it("says a shell-scoped story reads as shell-scoped", () => {
    expect(renderScopeReading(SHELL)).toContain("reads as shell-scoped");
  });

  it("says a page-scoped story reads as page-scoped, and says nothing about the shell", () => {
    // Distinguishable at a glance rather than by absence: the two conclusions must not look alike.
    const page = renderScopeReading(PAGE);

    expect(page).toContain("reads as page-scoped");
    expect(page).not.toContain("shell-scoped");
  });

  it("says so when no scope signal matched - the honest third case", () => {
    // Without this, a missing line would be ambiguous between not rendered, not computed, and no reading at all.
    expect(renderScopeReading(NEITHER)).toContain("matches no scope signal");
  });
});

describe("#784 - the reading is at the top of the plan", () => {
  it("renders above every section", () => {
    const lines = renderPlanFile(PLAN, { scope: SHELL }).split("\n");
    const scope = lines.findIndex((line) => line.startsWith("Scope:"));
    const firstSection = lines.findIndex((line) => line.startsWith("## "));

    expect(scope).toBeGreaterThan(-1);
    expect(firstSection).toBeGreaterThan(-1);
    expect(scope).toBeLessThan(firstSection);
  });

  it("CONTROL: a plan rendered without a reading carries no scope line", () => {
    // Existing callers pass no reading, so the line must stay optional rather than defaulting to a claim.
    expect(renderPlanFile(PLAN)).not.toContain("Scope:");
  });
});

describe("#784 - the reading stays provider- and repo-agnostic", () => {
  it("names no repository, vendor, extension or path", () => {
    // Pinned as an absence, with unambiguous tokens only: an earlier absence check in this initiative matched the
    // word "next" in ordinary prose and measured nothing.
    const named = ["agent-eve", "WebFeedPOC", "local-promotion-site", "vercel"];
    const extensions = [".jsx", ".tsx", ".py", "src/"];

    for (const reading of [SHELL, PAGE, NEITHER]) {
      const text = renderScopeReading(reading);
      expect(named.filter((token) => text.toLowerCase().includes(token.toLowerCase()))).toEqual([]);
      expect(extensions.filter((token) => text.includes(token))).toEqual([]);
    }
  });
});
