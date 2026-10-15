import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PLAN_APPROVAL_QUESTION,
  loadApprovedPlan,
  parkForApproval,
  planApprovalEventId,
  type PlanApprovalDeps,
} from "../../agent/lib/dark-factory/plan-approval";
import { planCommentBody } from "../../agent/lib/dark-factory/plan-comment";

/**
 * #365 R4 Task 2 — the run parks between planning and coding.
 *
 * The gate is only a gate if the run actually stops, so these tests assert the park records a BLOCKING
 * question, marks the ticket, and stops there — and that a re-delivery parks once, not twice.
 */
describe("the park (#365 R4 Task 2)", () => {
  const options = {
    runId: "run-1",
    repo: "ricardoblackskye/agent-eve",
    issue: 365,
    questionLabel: "needs-answer",
  };

  const deps = (overrides: Partial<PlanApprovalDeps> = {}): PlanApprovalDeps => ({
    reporter: {
      report: vi.fn().mockResolvedValue({
        ok: true,
        mode: "live",
        commentUrl: "https://github.com/o/r/issues/365#issuecomment-1",
      }),
    },
    labels: { add: vi.fn().mockResolvedValue({ ok: true }) },
    ...overrides,
  });

  it("asks a question, which is what makes the run blocked", async () => {
    const d = deps();
    const result = await parkForApproval(d, options);

    expect(result.ok).toBe(true);
    const report = (d.reporter.report as ReturnType<typeof vi.fn>).mock.calls[0][0];
    // "question" is not a cosmetic kind: run-history derives the run's status from it, and refuses a
    // worker.question whose status is not "blocked".
    expect(report.kind).toBe("question");
    expect(report.question).toBe(PLAN_APPROVAL_QUESTION);
    expect(report.runId).toBe("run-1");
    expect(report.issue).toBe(365);
    // Stable, so the same delivery parking twice records one event rather than two.
    expect(report.eventId).toBe(planApprovalEventId("run-1"));
  });

  it("marks the ticket, because the comment is not the only way a human sees the request", async () => {
    const d = deps();
    const result = await parkForApproval(d, options);
    expect(d.labels.add).toHaveBeenCalledWith(
      "ricardoblackskye/agent-eve",
      365,
      "needs-answer",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.labelApplied).toBe(true);
  });

  it("carries the comment url back, so the runner can point at the question", async () => {
    const result = await parkForApproval(deps(), options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.commentUrl).toContain("#issuecomment-1");
      expect(result.mode).toBe("live");
    }
  });

  it("fails closed when the question cannot be recorded at all", async () => {
    // Nothing was parked, so the run must NOT quietly continue into coding.
    const d = deps({
      reporter: { report: vi.fn().mockResolvedValue({ ok: false, mode: "blocked", error: "no token" }) },
    });
    const result = await parkForApproval(d, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("no token");
    expect(d.labels.add).not.toHaveBeenCalled();
  });

  it("stays parked, but says so loudly, when only the label fails", async () => {
    // Distinct from the case above on purpose: the run IS blocked once the question is recorded, so
    // reporting a failure would contradict the ledger. The human can still reply to resume.
    const d = deps({
      labels: { add: vi.fn().mockResolvedValue({ ok: false, error: "label write failed" }) },
    });
    const result = await parkForApproval(d, options);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.labelApplied).toBe(false);
      expect(result.warning).toContain("label write failed");
    }
  });

  it("records the question BEFORE marking the label, so a label outage cannot hide the question", async () => {
    const order: string[] = [];
    const d = deps({
      reporter: {
        report: vi.fn().mockImplementation(async () => {
          order.push("report");
          return { ok: true, mode: "live" };
        }),
      },
      labels: {
        add: vi.fn().mockImplementation(async () => {
          order.push("label");
          return { ok: true };
        }),
      },
    });
    await parkForApproval(d, options);
    expect(order).toEqual(["report", "label"]);
  });

  it("is wired into the runner AFTER the plan comment and BEFORE the coding loop", () => {
    // The ordering IS the requirement: parking before the plan is posted asks a human to approve something
    // they cannot see, and parking after the loop is not a gate at all. Asserted against the source because
    // neither ordering is observable from a unit test of this module or of the reporter.
    const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");
    const commentAt = runner.indexOf("postPlanComment(");
    const parkAt = runner.indexOf("parkForApproval(");
    const loopAt = runner.indexOf("await runCodingPhase(");
    expect(commentAt).toBeGreaterThan(-1);
    expect(parkAt).toBeGreaterThan(-1);
    expect(loopAt).toBeGreaterThan(-1);
    expect(commentAt).toBeLessThan(parkAt);
    expect(parkAt).toBeLessThan(loopAt);
  });

  it("returns from the runner at the park, so the loop is never reached", () => {
    const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");
    const parkAt = runner.indexOf("parkForApproval(");
    const afterPark = runner.slice(parkAt, parkAt + 1200);
    // A park that does not return is not a gate - it would fall through into coding.
    expect(afterPark).toMatch(/\breturn\b/);
  });

  it("gates the park on an EXPLICIT resume, so a re-delivery is never taken as approval", () => {
    const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");
    // The park must be conditional: unconditional, the run could never proceed to code; and keyed on
    // anything other than an explicit resume, a re-delivered event would silently count as approval.
    expect(runner).toContain('process.argv.includes("--resume")');
    const guardAt = runner.indexOf('process.argv.includes("--resume")');
    const parkAt = runner.indexOf("parkForApproval(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(parkAt).toBeGreaterThan(guardAt);
  });
});

/**
 * #365 R4 Task 3 — a resumed dispatch codes against the plan a human approved.
 *
 * Re-planning on a resume would code against a DIFFERENT plan than the one that was reviewed: the human
 * approved a specific plan, not the architect's next attempt. So the plan is read back off the ticket.
 */
describe("resuming against the approved plan (#365 R4 Task 3)", () => {
  const APPROVED = { storyId: 365, summary: "the plan a human read" };

  const comments = (list: { id: number; body: string }[]) => ({
    listComments: vi.fn().mockResolvedValue({ ok: true, comments: list }),
  });

  it("reads the plan back from the Factory's own comment, among other people's", async () => {
    const deps = comments([
      { id: 1, body: "someone else's discussion" },
      { id: 2, body: planCommentBody("# Plan: approved\n", APPROVED) },
      { id: 3, body: "another reply" },
    ]);
    const result = await loadApprovedPlan(deps, { owner: "o", repo: "r", issue: 365 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan).toEqual(APPROVED);
  });

  it("fails closed when the ticket carries no plan comment", async () => {
    const result = await loadApprovedPlan(comments([{ id: 1, body: "just a reply" }]), {
      owner: "o",
      repo: "r",
      issue: 365,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no approved plan/);
  });

  it("fails closed when the comments cannot be read at all", async () => {
    const deps = { listComments: vi.fn().mockResolvedValue({ ok: false, error: "GitHub responded 403" }) };
    const result = await loadApprovedPlan(deps, { owner: "o", repo: "r", issue: 365 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("403");
  });

  it("fails closed on a plan comment with no machine-readable block", async () => {
    // A comment posted before the block existed. Falling back to re-planning would be worse: it would code
    // against something nobody approved.
    const deps = comments([{ id: 1, body: planCommentBody("# Plan: posted before the block existed\n") }]);
    const result = await loadApprovedPlan(deps, { owner: "o", repo: "r", issue: 365 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/machine-readable/);
  });

  it("labels and comments on the RUN's repo, not a hardcoded one (#348)", () => {
    const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");
    // Four call sites passed ("ricardoblackskye", "agent-eve") as literals, including the planning-failure
    // path, so a run for any other repository would have labelled and commented on the WRONG one. The
    // remaining repo literals are the default target and the allowed-repos default, which #348 replaces
    // wholesale along with the single-repo assumption behind them.
    expect(runner).not.toMatch(/"ricardoblackskye",\s*"agent-eve"/);
    expect(runner).toContain("repoOwner, repoName");
  });

  it("has the runner read the approved plan instead of re-planning on a resume", () => {
    const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");
    const resumeAt = runner.indexOf("loadApprovedPlan(");
    const planAt = runner.indexOf("architectAgent.planStory(");
    // The approved plan is read back BEFORE the architect is reached, so a resume can never re-plan - and
    // the architect is still reached on a fresh run, which the next assertion pins.
    expect(resumeAt).toBeGreaterThan(-1);
    expect(planAt).toBeGreaterThan(-1);
    expect(resumeAt).toBeLessThan(planAt);
  });
});
