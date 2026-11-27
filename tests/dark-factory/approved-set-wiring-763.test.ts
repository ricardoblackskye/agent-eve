import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #763 R2 - the join. This is the assertion the issue asks for verbatim:
 *
 *   "Assert the join - that the executed path really is checked against the approved plan."
 *
 * The rule and its behaviour are tested separately (`approved-target-set-763.test.ts`). What this file adds is that
 * the RUNNER actually consults the rule, at the right place, about the right things - because a correct rule that
 * nothing calls is exactly how the existence check in #770 came to be a rule that could not fire.
 *
 * A source-text guard is the weakest kind of evidence, so it is written to be as hard to make vacuous as possible,
 * and it is deliberately paired with `tsc` and the suite rather than standing alone: #704's ordering guard reported a
 * call present and correctly ordered while the file did not compile. Bounded to the AUTHORING block, because in a
 * 2,800-line file a bare `toContain` passes wherever the call sits.
 */
const SOURCE = readFileSync(resolve(process.cwd(), "scripts/dark-factory-runner.ts"), "utf8");

/** The authoring block: from where the run records what it wrote, to the loop that consumes it. */
function authoringBlock(source: string): string {
  const anchor = "lastAuthored = authored;";
  const from = source.indexOf(anchor);
  const to = source.indexOf("for (const filePath of authored.written)", from);
  return from === -1 || to === -1 ? "" : source.slice(from, to);
}

describe("#763 R2 - the runner checks what it wrote against the approved set", () => {
  it("finds the authoring block, so this guard cannot pass by finding nothing", () => {
    // Without this, a rename of either anchor would make every case below pass over an empty string.
    expect(authoringBlock(SOURCE).length).toBeGreaterThan(0);
  });

  it("consults the approved set with the run's OWN written paths and the approved plan", () => {
    const block = authoringBlock(SOURCE);

    // The join, in both directions: the set it checks is what was written, and it checks it against the plan.
    expect(block).toContain("pathsOutsideApprovedSet(authored.written, ctx.plan");
  });

  it("refuses when a path is outside, naming it", () => {
    const block = authoringBlock(SOURCE);

    expect(block).toContain("outsideApprovedSet.length > 0");
    // The refusal must name what escaped - a message that says "a violation occurred" is not actionable.
    expect(block).toContain("outsideApprovedSet.join(");
  });

  it("does NOT widen the approved set to accommodate the write", () => {
    const block = authoringBlock(SOURCE);

    // The direction of safety, asserted as an absence: nothing here may mutate the plan's targets.
    expect(block).not.toContain("targetFiles.push");
    expect(block).not.toContain("targetFiles =");
    expect(block).not.toContain("ctx.plan.targetFiles");
  });
});
