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
    // #538: the plan's content survives, rendered the way a comment needs it - no page-sized headings.
    expect(body).toContain("**Plan: something**");
    expect(body).toContain("### Goal");
    expect(body).not.toMatch(/^#{1,2} /m);
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
      const humanAt = body.indexOf("Plan: something");
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

/**
 * #488 — the estimate reaches the comment a human reads before approving (epic #453).
 *
 * The estimate is persisted AFTER this comment is posted (#487, Option B), so the band must be computed
 * in memory and rendered here; the comment can never read it back from the ledger.
 */
describe("#488 the estimate in the plan comment", () => {
  const MARKDOWN = "# Plan: something\n\n## Goal\n\nmake it better\n";
  const PLAN = { storyId: 488, approach: "surface the band" };
  const ESTIMATE = {
    lowUsd: 0.1,
    expectedUsd: 0.2,
    highUsd: 0.41,
    costClass: "XS" as const,
    confidence: "low" as const,
    features: {},
  };

  const target = (overrides: Partial<PlanCommentTarget> = {}): PlanCommentTarget => ({
    listComments: vi.fn().mockResolvedValue({ ok: true, comments: [] }),
    postComment: vi.fn().mockResolvedValue({ ok: true, id: 11 }),
    editComment: vi.fn().mockResolvedValue({ ok: true, id: 12 }),
    ...overrides,
  });

  it("renders the band under the marker, above the plan", () => {
    const body = planCommentBody(MARKDOWN, PLAN, ESTIMATE);
    const markerAt = body.indexOf(PLAN_COMMENT_MARKER);
    const estimateAt = body.indexOf("Estimated cost:");
    const planAt = body.indexOf("Plan: something");
    expect(markerAt).toBe(0);
    expect(estimateAt).toBeGreaterThan(markerAt);
    // A reviewer must meet the forecast BEFORE committing to read the plan.
    expect(estimateAt).toBeLessThan(planAt);
  });

  it("omits the section entirely when there is no estimate", () => {
    const body = planCommentBody(MARKDOWN, PLAN);
    expect(body).not.toContain("Estimated cost");
    expect(body).not.toMatch(/unknown/i);
  });

  it("keeps the human rendering above the machine block", () => {
    const body = planCommentBody(MARKDOWN, PLAN, ESTIMATE);
    const estimateAt = body.indexOf("Estimated cost:");
    // Asserted present FIRST: an absent section would make indexOf return -1, which is less than
    // anything, so a bare comparison would pass without the section existing at all.
    expect(estimateAt).toBeGreaterThan(-1);
    expect(estimateAt).toBeLessThan(body.indexOf("<details>"));
  });

  it("still round-trips the plan with an estimate present", () => {
    // The section joins the HUMAN part; the machine block must stay last and intact, or a resumed run
    // cannot read its plan back (#365 R4) and stops.
    const parsed = parsePlanFromComment(planCommentBody(MARKDOWN, PLAN, ESTIMATE));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan).toEqual(PLAN);
  });

  // AC5. One case per test, so the snapshot key is the test name.
  it("snapshots the comment body WITH an estimate", () => {
    expect(planCommentBody(MARKDOWN, PLAN, ESTIMATE)).toMatchSnapshot();
  });

  it("snapshots the comment body WITHOUT an estimate", () => {
    expect(planCommentBody(MARKDOWN, PLAN)).toMatchSnapshot();
  });

  it("passes the estimate through the poster", async () => {
    const writer = target();
    await postPlanComment(writer, {
      owner: "o",
      repo: "r",
      issue: 488,
      markdown: MARKDOWN,
      plan: PLAN,
      estimate: ESTIMATE,
    });
    const posted = (writer.postComment as ReturnType<typeof vi.fn>).mock.calls[0][3] as string;
    expect(posted).toContain("Estimated cost:");
  });
});
