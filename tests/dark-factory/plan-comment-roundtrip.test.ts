/**
 * #373 — the plan must survive the wait on the ticket, so posting and reading must be the SAME body.
 *
 * The resume exposed this. A real run posted its plan, parked for approval, and on `--resume` could not read
 * the plan back:
 *
 *   the approved plan could not be read: the plan comment carries no machine-readable plan
 *   (a comment posted before this release has none)
 *
 * That comment was written by the same release. It carried the marker and the rendered markdown, and no
 * machine-readable block at all — because the runner called `postPlanComment` with `markdown` and no `plan`,
 * and `planCommentBody(markdown, plan?)` returns human markdown alone when `plan` is undefined.
 *
 * So the builder that owns the block, and that has its own passing round-trip test, was never the one the
 * runner used. The gap was invisible because `plan` is OPTIONAL: an omission compiles, runs, and posts a plan
 * that can never be read back. These two cases pin the wiring and the diagnosis, and the fix makes `plan`
 * required so no future call site can omit it in silence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePlanFromComment,
  planCommentBody,
} from "../../agent/lib/dark-factory/plan-comment";

const RUNNER = join(process.cwd(), "scripts", "dark-factory-runner.ts");
const MARKDOWN = "# Plan: the ticket\n\nBody.\n";
const PLAN = { storyId: 162, summary: "add a sub-heading" };

describe("#373 the plan survives the ticket round-trip", () => {
  it("gives postPlanComment the PLAN, not only the human markdown", () => {
    const source = readFileSync(RUNNER, "utf8");

    const callAt = source.indexOf("postPlanComment(");
    expect(callAt).toBeGreaterThan(-1);

    // The argument, not merely the call: a call site without `plan` posts a comment no resume can read,
    // which is the defect, and it type-checked only because the field was optional.
    const call = source.slice(callAt, callAt + 600);
    expect(call).toMatch(/\bplan:/);
  });

  it("does not blame a previous release when the marker proves the comment is ours", () => {
    // `planCommentBody(MARKDOWN)` with no plan is EXACTLY the shape the runner posted: marker, markdown, no
    // block. The reader must fail closed on it, but it must not claim the comment predates the feature.
    const parsed = parsePlanFromComment(planCommentBody(MARKDOWN));

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/machine-readable/);
      expect(parsed.error).not.toMatch(/before this release/);
    }
  });

  it("round-trips a plan through the body the runner is now required to post", () => {
    const parsed = parsePlanFromComment(planCommentBody(MARKDOWN, PLAN));

    expect(parsed).toEqual({ ok: true, plan: PLAN });
  });
});
