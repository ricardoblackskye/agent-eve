import { describe, expect, it } from "vitest";
import { renderPlanFile } from "../../agent/lib/dark-factory/plan-file";
import {
  COMMENT_TABLE_CELL_LIMIT,
  normalizeCommentMarkdown,
  parsePlanFromComment,
  planCommentBody,
  parsePlanFromComments,
  planBlockBody,
} from "../../agent/lib/dark-factory/plan-comment";

/**
 * #538 - a posted comment is rendered for a COMMENT, not for the plan file.
 *
 * Measured on the real comment (WebFeedPOC#176): 21,471 characters, one H1, five H2s, and a Files table whose
 * longest cell was 651 characters against an Acceptance criteria table topping out at 68. The fixture below is
 * shaped from that measurement rather than invented, and the long rationale is pinned to its measured length.
 */
const LONG_RATIONALE = "The rationale is deliberately long here, exactly as the real comment's was, because a rationale explains why this file changes and what would break if it did not; a truncated one would be a worse lie than a wide table, which is the whole reason it moves below rather than being cut. The rationale is deliberately long here, exactly as the real comment's was, because a rationale explains why this file changes and what would break if it did not; a truncated one would be a worse lie than a wide table, which is the whole reason it moves below rather than being cut. The rationale is deliberately long here, exactly as the real comment's was, because a";
const SHORT_RATIONALE = "Append one footer line; no other file is touched.";

const plan = (rationale: string = LONG_RATIONALE, over: Record<string, unknown> = {}) => ({
  title: "Add a footer line to the home page",
  storyId: 177,
  summary: "One italic line, home page only.",
  approach: "Append a semantic footer element to the page component.",
  tasks: [
    { title: "Edit the page", objective: "Add the line.", steps: ["Open the component"], verification: "vitest run" },
  ],
  targetFiles: [{ path: "src/pages/HomePage.jsx", action: "modify", rationale }],
  acceptanceCriteriaMap: [{ acId: "AC1", description: "The footer line renders", testFile: "src/pages/HomePage.test.jsx", testCaseName: "renders the footer" }],
  ...over,
});
const fileMarkdown = (rationale: string = LONG_RATIONALE) => renderPlanFile(plan(rationale));

/** The table whose header names these columns, as raw lines. */
function tableLines(markdown: string, firstHeaderCell: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => l.startsWith("|") && l.includes(firstHeaderCell));
  if (start === -1) return [];
  const rows: string[] = [];
  for (let i = start; i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i]);
  return rows;
}
const cells = (row: string) => row.split("|").slice(1, -1).map((c) => c.trim());

describe("#538 - headings in a comment", () => {
  it("uses no H1 and no H2, and H3 is the highest level", () => {
    const levels = [...normalizeCommentMarkdown(fileMarkdown()).matchAll(/^(#{1,6}) /gm)].map((m) => m[1].length);

    expect(levels).not.toContain(1);
    expect(levels).not.toContain(2);
    expect(Math.min(...levels)).toBe(3);
  });

  it("turns the title into a bold line and demotes every heading below it by exactly one", () => {
    const out = normalizeCommentMarkdown(fileMarkdown());

    expect(out).toContain("**Plan: Add a footer line to the home page**");
    expect(out).toContain("### Goal");
    expect(out).toContain("### Files to change");
    expect(out).toContain("#### 1. Edit the page");
  });

  it("leaves the body text alone", () => {
    expect(normalizeCommentMarkdown(fileMarkdown())).toContain("One italic line, home page only.");
  });
});

describe("#538 - a long prose cell leaves the table rather than being cut", () => {
  it("keeps the rationale IN FULL, below the table, keyed by the file", () => {
    const out = normalizeCommentMarkdown(fileMarkdown());

    expect(out).toContain(LONG_RATIONALE);
    expect(out.indexOf(LONG_RATIONALE)).toBeGreaterThan(out.indexOf("src/pages/HomePage.jsx"));
    expect(out).toMatch(/HomePage\.jsx.*\n.*— /s);
  });

  it("no table cell in the comment exceeds the limit", () => {
    const out = normalizeCommentMarkdown(fileMarkdown());
    const rows = tableLines(out, "| File |");
    const widest = Math.max(...rows.flatMap(cells).map((c) => c.length));

    expect(widest).toBeLessThanOrEqual(COMMENT_TABLE_CELL_LIMIT);
  });

  it("leaves a SHORT rationale exactly where it is, so plans that read well are untouched", () => {
    const fileTable = tableLines(fileMarkdown(SHORT_RATIONALE), "| File |");
    const commentTable = tableLines(normalizeCommentMarkdown(fileMarkdown(SHORT_RATIONALE)), "| File |");

    expect(commentTable).toEqual(fileTable);
  });

  it("leaves the Acceptance criteria table byte-identical (its cells are short by construction)", () => {
    const before = tableLines(fileMarkdown(), "| AC |");
    const after = tableLines(normalizeCommentMarkdown(fileMarkdown()), "| AC |");

    expect(after).toEqual(before);
  });

  it("does NOT move a row that is long only in its key column", () => {
    const long = "src/" + "deeply/".repeat(40) + "HomePage.jsx";
    const out = normalizeCommentMarkdown(renderPlanFile(plan(SHORT_RATIONALE, {
      targetFiles: [{ path: long, action: "modify", rationale: SHORT_RATIONALE }],
    })));

    expect(out).toContain("| \`" + long + "\` | modify | " + SHORT_RATIONALE + " |");
  });
});

describe("#538 - the boundary: the file and the machine payload are untouched", () => {
  it("the plan FILE keeps its H1 and its H2 sections", () => {
    expect(fileMarkdown()).toContain("# Plan: Add a footer line to the home page");
    expect(fileMarkdown()).toContain("## Files to change");
  });

  it("a resumed run can still read the plan back, and #538's comment rendering does not break the pair", () => {
    // #518: the machine block is its own comment now, so the read-back is over the pair. The point #538 pinned
    // still stands: rendering the HUMAN half for a comment must not cost the read-back.
    const plan = { storyId: 538, approach: "add a footer line to the home page" };
    const parsed = parsePlanFromComments([
      { id: 1, body: planCommentBody(fileMarkdown()) },
      { id: 2, body: planBlockBody(plan) },
    ]);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan).toEqual(plan);
  });

  it("re-posting the same plan produces the same body", () => {
    expect(planCommentBody(fileMarkdown())).toBe(planCommentBody(fileMarkdown()));
  });

  it("the WHOLE comment has no H1 or H2, the estimate section included", () => {
    const body = planCommentBody(fileMarkdown(), {
      lowUsd: 0.1, highUsd: 0.2, costClass: "small", confidence: "medium",
    } as never);

    expect(/^#{1,2} /m.test(body)).toBe(false);
  });
});
