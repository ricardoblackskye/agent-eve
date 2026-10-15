import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PLAN_COMMENT_MARKER,
  findPlanComment,
  planCommentBody,
  postPlanComment,
  type PlanCommentTarget,
} from "../../agent/lib/dark-factory/plan-comment";

/**
 * #365 Task 11 — the plan is posted on the ticket BEFORE the coding loop, exactly once.
 *
 * Before this, the plan only reached the branch and only after the run finished, so a run that failed
 * during coding left nothing reviewable on the ticket.
 */
describe("the plan comment (#365 Task 11)", () => {
  const MARKDOWN = "# Plan: something\n\n## Goal\n\nmake it better\n";

  const target = (overrides: Partial<PlanCommentTarget> = {}): PlanCommentTarget => ({
    listComments: vi.fn().mockResolvedValue({ ok: true, comments: [] }),
    postComment: vi.fn().mockResolvedValue({ ok: true, id: 11 }),
    editComment: vi.fn().mockResolvedValue({ ok: true, id: 12 }),
    ...overrides,
  });

  it("marks the comment and keeps the plan intact", () => {
    const body = planCommentBody(MARKDOWN);
    expect(body).toContain(PLAN_COMMENT_MARKER);
    expect(body).toContain("# Plan: something");
    // The marker leads, so a human scanning the ticket sees the plan first, not an HTML comment.
    expect(body.startsWith(PLAN_COMMENT_MARKER)).toBe(true);
  });

  it("finds its own comment among other people's", () => {
    const found = findPlanComment([
      { id: 1, body: "unrelated discussion" },
      { id: 2, body: "another" },
      { id: 3, body: `${PLAN_COMMENT_MARKER}\n\n# Plan: earlier` },
    ]);
    expect(found?.id).toBe(3);
  });

  it("returns nothing when there is no plan comment", () => {
    expect(findPlanComment([{ id: 1, body: "unrelated" }])).toBeUndefined();
    expect(findPlanComment([])).toBeUndefined();
    // A comment the API returned without a body must not blow it up.
    expect(findPlanComment([{ id: 1, body: null }])).toBeUndefined();
  });

  it("posts the plan when the ticket has none", async () => {
    const writer = target();
    const result = await postPlanComment(writer, {
      owner: "o",
      repo: "r",
      issue: 7,
      markdown: MARKDOWN,
    });
    expect(result).toEqual({ ok: true, action: "created", id: 11 });
    expect(writer.postComment).toHaveBeenCalledTimes(1);
    expect(writer.editComment).not.toHaveBeenCalled();
  });

  it("updates its own comment instead of posting a second one, so a retry does not duplicate it", async () => {
    const writer = target({
      listComments: vi
        .fn()
        .mockResolvedValue({ ok: true, comments: [{ id: 42, body: PLAN_COMMENT_MARKER }] }),
    });

    const result = await postPlanComment(writer, {
      owner: "o",
      repo: "r",
      issue: 7,
      markdown: MARKDOWN,
    });

    expect(result).toEqual({ ok: true, action: "updated", id: 12 });
    // The duplicate is the bug being prevented: the ticket must not collect one comment per attempt.
    expect(writer.postComment).not.toHaveBeenCalled();
    expect(writer.editComment).toHaveBeenCalledWith("o", "r", 42, expect.stringContaining(PLAN_COMMENT_MARKER));
  });

  it("reports a failure instead of throwing, so the caller decides the policy", async () => {
    const writer = target({
      listComments: vi.fn().mockResolvedValue({ ok: false, error: "GitHub responded 403" }),
    });

    const result = await postPlanComment(writer, {
      owner: "o",
      repo: "r",
      issue: 7,
      markdown: MARKDOWN,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("403");
    }
    expect(writer.postComment).not.toHaveBeenCalled();
  });

  it("reports a failure when the post itself fails", async () => {
    const writer = target({
      postComment: vi.fn().mockResolvedValue({ ok: false, error: "GitHub responded 422" }),
    });
    const result = await postPlanComment(writer, {
      owner: "o",
      repo: "r",
      issue: 7,
      markdown: MARKDOWN,
    });
    expect(result.ok).toBe(false);
  });

  it("is wired into the runner BEFORE the coding loop", () => {
    // The ordering IS the requirement: a plan comment posted after the loop leaves a failed run with
    // nothing reviewable, which is the whole point of the task. Asserted against the source because the
    // ordering cannot be observed from a unit test of either piece.
    const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");
    const commentAt = runner.indexOf("postPlanComment(");
    const loopAt = runner.indexOf("await runCodingPhase(");
    expect(commentAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(-1);
    expect(commentAt).toBeLessThan(loopAt);
  });
});
