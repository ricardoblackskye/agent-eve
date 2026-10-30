import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PLAN_COMMENT_MARKER,
  findPlanComment,
  parsePlanFromComment,
  planCommentBody,
  postPlanComment,
  type PlanCommentTarget,
  PLAN_BLOCK_MARKER,
  MAX_COMMENT_CHARS,
  planBlockBody,
  parsePlanFromComments,
} from "../../agent/lib/dark-factory/plan-comment";
import { renderPlanFile } from "../../agent/lib/dark-factory/plan-file";
import { ARCHITECT_OUTPUT_TOKENS } from "../../agent/lib/dark-factory/plan-cost-estimate";

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
    // #518: two comments now - the human plan and its machine block.
    expect(result).toEqual({ ok: true, action: "created", id: 11, blockId: 11 });
    expect(writer.postComment).toHaveBeenCalledTimes(2);
    expect(writer.editComment).not.toHaveBeenCalled();
  });

  it("updates both of its own comments instead of posting more, so a retry does not duplicate it", async () => {
    const writer = target({
      listComments: vi.fn().mockResolvedValue({
        ok: true,
        comments: [
          { id: 42, body: PLAN_COMMENT_MARKER },
          { id: 43, body: PLAN_BLOCK_MARKER },
        ],
      }),
    });

    const result = await postPlanComment(writer, {
      owner: "o",
      repo: "r",
      issue: 7,
      markdown: MARKDOWN,
      plan: { storyId: 7 },
    });

    expect(result).toEqual({ ok: true, action: "updated", id: 12, blockId: 12 });
    // The duplicate is the bug being prevented: the ticket must not collect one comment per attempt.
    expect(writer.postComment).not.toHaveBeenCalled();
    expect(writer.editComment).toHaveBeenCalledWith("o", "r", 42, expect.stringContaining(PLAN_COMMENT_MARKER));
    expect(writer.editComment).toHaveBeenCalledWith("o", "r", 43, expect.stringContaining(PLAN_BLOCK_MARKER));
  });

  it("upgrades a ticket that predates the split by adding the block comment once", async () => {
    // The real shape of every ticket that already carries a plan: one comment, no block. The run must not
    // re-post the human comment, and must add exactly one block.
    const writer = target({
      listComments: vi.fn().mockResolvedValue({ ok: true, comments: [{ id: 42, body: PLAN_COMMENT_MARKER }] }),
    });

    const result = await postPlanComment(writer, {
      owner: "o",
      repo: "r",
      issue: 7,
      markdown: MARKDOWN,
      plan: { storyId: 7 },
    });

    expect(result).toEqual({ ok: true, action: "updated", id: 12, blockId: 11 });
    expect(writer.editComment).toHaveBeenCalledTimes(1);
    expect(writer.postComment).toHaveBeenCalledTimes(1);
    expect(writer.postComment).toHaveBeenCalledWith("o", "r", 7, expect.stringContaining("<details>"));
    const parsed = parsePlanFromComments([
      { id: 42, body: MARKDOWN },
      { id: 11, body: (writer.postComment as ReturnType<typeof vi.fn>).mock.calls[0][3] as string },
    ]);
    expect(parsed.ok).toBe(true);
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

    it("round-trips the plan through the pair of comments that were posted", () => {
      // #518: the block moved into its own comment, so the round-trip is over the pair.
      const parsed = parsePlanFromComments([
        { id: 1, body: planCommentBody(MARKDOWN) },
        { id: 2, body: planBlockBody(PLAN) },
      ]);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.plan).toEqual(PLAN);
    });

    it("keeps the human rendering and the machine block in separate comments", () => {
      const human = planCommentBody(MARKDOWN);
      const block = planBlockBody(PLAN);
      expect(human.indexOf("Plan: something")).toBeGreaterThan(-1);
      expect(human).not.toContain("<details>");
      expect(block).toContain("<details>");
      expect(block).not.toContain("Plan: something");
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
      // #518: the block is its own comment now, and it is still escaped.
      const parsed = parsePlanFromComments([
        { id: 1, body: planCommentBody(MARKDOWN) },
        { id: 2, body: planBlockBody(hostile) },
      ]);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.plan).toEqual(hostile);
    });

    it("posts the plan, as a human comment and its machine block", async () => {
      const writer = target();
      await postPlanComment(writer, {
        owner: "o",
        repo: "r",
        issue: 7,
        markdown: MARKDOWN,
        plan: PLAN,
      });
      const calls = (writer.postComment as ReturnType<typeof vi.fn>).mock.calls;
      const humanPosted = calls[0][3] as string;
      const blockPosted = calls[1][3] as string;
      expect(humanPosted).toContain(PLAN_COMMENT_MARKER);
      expect(humanPosted).not.toContain("<details>");
      const parsed = parsePlanFromComments([
        { id: 1, body: humanPosted },
        { id: 2, body: blockPosted },
      ]);
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
    const body = planCommentBody(MARKDOWN, ESTIMATE);
    const markerAt = body.indexOf(PLAN_COMMENT_MARKER);
    const estimateAt = body.indexOf("Estimated cost:");
    const planAt = body.indexOf("Plan: something");
    expect(markerAt).toBe(0);
    expect(estimateAt).toBeGreaterThan(markerAt);
    // A reviewer must meet the forecast BEFORE committing to read the plan.
    expect(estimateAt).toBeLessThan(planAt);
  });

  it("omits the section entirely when there is no estimate", () => {
    const body = planCommentBody(MARKDOWN);
    expect(body).not.toContain("Estimated cost");
    expect(body).not.toMatch(/unknown/i);
  });

  it("keeps the forecast in the plan comment, ahead of the plan, with no block beside it", () => {
    const body = planCommentBody(MARKDOWN, ESTIMATE);
    const estimateAt = body.indexOf("Estimated cost:");
    // Asserted present FIRST: an absent section would make indexOf return -1, which is less than
    // anything, so a bare comparison would pass without the section existing at all.
    expect(estimateAt).toBeGreaterThan(-1);
    expect(estimateAt).toBeLessThan(body.indexOf("Plan: something"));
    // #518: the machine block is a separate comment now, so it must not be in the reader's way here.
    expect(body).not.toContain("<details>");
  });

  it("still round-trips the plan with an estimate present", () => {
    // The section joins the HUMAN part; the machine block must stay last and intact, or a resumed run
    // cannot read its plan back (#365 R4) and stops.
    const parsed = parsePlanFromComments([
      { id: 1, body: planCommentBody(MARKDOWN, ESTIMATE) },
      { id: 2, body: planBlockBody(PLAN) },
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.plan).toEqual(PLAN);
  });

  // AC5. One case per test, so the snapshot key is the test name.
  it("snapshots the comment body WITH an estimate", () => {
    expect(planCommentBody(MARKDOWN, ESTIMATE)).toMatchSnapshot();
  });

  it("snapshots the comment body WITHOUT an estimate", () => {
    expect(planCommentBody(MARKDOWN)).toMatchSnapshot();
    // #518: the block is its own comment, so snapshot it too - the half that a resumed run reads.
    expect(planBlockBody(PLAN)).toMatchSnapshot();
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

describe("#518 the plan comment is bounded, and the machine block gets its own comment", () => {
  const filler = (n: number) => "x".repeat(n);
  // The fixture is DERIVED from the Architect's output budget, so it moves when that constant moves.
  const budgetChars = ARCHITECT_OUTPUT_TOKENS * 4;
  const worstCasePlan = {
    storyId: 518,
    approach: filler(2000),
    tasks: Array.from({ length: 40 }, (_, i) => ({ title: `task ${i + 1}`, objective: filler(400) })),
    targetFiles: Array.from({ length: 24 }, (_, i) => ({
      path: `src/module-${i + 1}.ts`,
      action: "modify",
      rationale: filler(500),
    })),
  };
  const markdown = renderPlanFile(worstCasePlan as never, {
    issueUrl: "https://github.com/o/r/issues/1",
  });
  const human = planCommentBody(markdown);
  const block = planBlockBody(worstCasePlan);

  it("the fixture really is the worst case (tied to the Architect's budget, not guessed)", () => {
    expect(markdown.length + JSON.stringify(worstCasePlan).length).toBeGreaterThanOrEqual(budgetChars);
  });

  it("each comment fits the budget, and the pair is why one comment did not", () => {
    expect(human.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(block.length).toBeLessThanOrEqual(MAX_COMMENT_CHARS);
    expect(human.length + block.length).toBeGreaterThan(MAX_COMMENT_CHARS);
  });

  it("the human comment carries no machine block; the block comment carries nothing else", () => {
    expect(human).not.toContain("<details>");
    expect(human).toContain(PLAN_COMMENT_MARKER);
    expect(block).toContain(PLAN_BLOCK_MARKER);
    expect(block).toContain("<details>");
  });

  it("resume round-trip at size: the plan comes back from the pair", () => {
    const parsed = parsePlanFromComments([
      { id: 1, body: human },
      { id: 2, body: block },
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.plan).toEqual(worstCasePlan);
    }
  });

  it("a legacy single-comment plan still resumes (#518 decision 3)", () => {
    const legacyBlock = planBlockBody(worstCasePlan).replace(`${PLAN_BLOCK_MARKER}\n\n`, "");
    const parsed = parsePlanFromComments([{ id: 1, body: `${human}\n\n${legacyBlock}` }]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.plan).toEqual(worstCasePlan);
    }
  });

  it("over budget fails naming the limit, and refuses BEFORE touching the network", async () => {
    const calls: string[] = [];
    const target: PlanCommentTarget = {
      listComments: async () => {
        calls.push("list");
        return { ok: true, comments: [] };
      },
      postComment: async () => {
        calls.push("post");
        return { ok: true, id: 1 };
      },
      editComment: async () => {
        calls.push("edit");
        return { ok: true, id: 1 };
      },
    };
    const result = await postPlanComment(target, {
      owner: "o",
      repo: "r",
      issue: 1,
      markdown: filler(MAX_COMMENT_CHARS + 1000),
      plan: worstCasePlan,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(String(MAX_COMMENT_CHARS));
      expect(result.error).toMatch(/budget|limit/i);
    }
    expect(calls).toEqual([]);
  });
});
