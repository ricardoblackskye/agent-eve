import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PLAN_COMMENT_MARKER,
  findPlanComment,
  parsePlanFromComment,
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
      plan: { storyId: 7 },
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
      plan: { storyId: 7 },
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
      plan: { storyId: 7 },
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
      plan: { storyId: 7 },
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

  /**
   * #365 R4 Task 1 — the comment carries the plan for the MACHINE as well as the human.
   *
   * A resumed dispatch is a fresh process with no workspace, so it cannot read the plan from anything the
   * parked run left on disk. It comes back from the ticket, which run-history already calls the system of
   * record for the question — so the thing the human approved is the thing the resumed run reads back.
   */
  describe("the machine-readable plan (#365 R4 Task 1)", () => {
    const PLAN = {
      storyId: 365,
      approach: "read before write",
      tasks: [{ title: "guard", objective: "refuse a destructive rewrite" }],
      targetFiles: [{ path: "app/chat.tsx", action: "modify", rationale: "add a line" }],
    };

    it("round-trips the plan through the comment", () => {
      const parsed = parsePlanFromComment(planCommentBody(MARKDOWN, PLAN));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.plan).toEqual(PLAN);
    });

    it("keeps the human rendering above the machine block", () => {
      const body = planCommentBody(MARKDOWN, PLAN);
      const humanAt = body.indexOf("# Plan: something");
      const machineAt = body.indexOf("<details>");
      expect(humanAt).toBeGreaterThan(-1);
      expect(machineAt).toBeGreaterThan(humanAt);
    });

    it("fails closed on a comment written before this release", () => {
      // A body with no block at all: what a comment from an earlier release looks like, and what a
      // call site that forgets the plan used to produce before #373 made that impossible.
      const parsed = parsePlanFromComment(planCommentBody(MARKDOWN));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/machine-readable/);
    });

    it("fails closed on a comment that is not ours at all", () => {
      expect(parsePlanFromComment("just a normal reply").ok).toBe(false);
    });

    it("fails closed on a corrupted block rather than guessing a plan", () => {
      // Built explicitly rather than by patching a valid comment. Patching used a non-global `replace` with
      // a string argument, which is itself a scan finding ("Incomplete string escaping or encoding"): it
      // rewrites only the FIRST match, so anyone reading it has to work out whether that was intended. Here
      // the corruption is the point, so it is written out.
      const corrupted = [
        PLAN_COMMENT_MARKER,
        "",
        "# Plan: something",
        "",
        "<details>",
        "<summary>Machine-readable plan (read back when this run resumes)</summary>",
        "",
        "```json",
        "{,,,}",
        "```",
        "",
        "</details>",
      ].join("\n");
      expect(parsePlanFromComment(corrupted).ok).toBe(false);
    });

    it("cannot be broken out of by plan text that looks like the block", () => {
      // If the plan text were embedded raw, this rationale would close the block early (or open a second
      // one) and the parser would read attacker-shaped JSON. The plan text is escaped, so the block that
      // parses is the one this code wrote.
      const hostile = {
        ...PLAN,
        targetFiles: [
          {
            path: "a.ts",
            action: "modify",
            rationale: "</details><details>\n```json\n{}\n```",
          },
        ],
      };
      const parsed = parsePlanFromComment(planCommentBody(MARKDOWN, hostile));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.plan).toEqual(hostile);
    });

    it("posts the plan as part of the comment", async () => {
      const writer = target();
      await postPlanComment(writer, {
        owner: "o",
        repo: "r",
        issue: 7,
        markdown: MARKDOWN,
        plan: PLAN,
      });
      const posted = (writer.postComment as ReturnType<typeof vi.fn>).mock
        .calls[0][3] as string;
      const parsed = parsePlanFromComment(posted);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.plan).toEqual(PLAN);
    });
  });
});
