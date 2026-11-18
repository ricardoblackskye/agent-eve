/**
 * #691 — a run whose checks have not finished must SAY so, machine-readably.
 *
 * The WebFeedPOC#232 run ended `blocked` with two findings side by side:
 *
 *   PR-CHECK-UNSETTLED:e2e          the check has not finished (in_progress)
 *   PR-CHECK-FAILED:MegaLinter      the repository's own check failed
 *
 * An `e2e` suite still running at the twenty-minute cap was indistinguishable, in the outcome, from a
 * check that ran and said no - and that one may yet pass. `checkRunFindings` already distinguishes
 * them by id; nothing downstream read it, and `reason` is prose a human reads.
 *
 * What this does NOT change: the certification. A run may not report done against an outcome it
 * cannot see (659 Stage 3), so the control below asserts that refusal survives.
 */
import { describe, it, expect, vi } from "vitest";
import {
  checkRunFindings,
  runDefinitionOfDone,
  unfinishedChecks,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneTask,
} from "../../agent/lib/dark-factory/definition-of-done";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

const plan: ExecutionPlan = {
  storyId: 179,
  title: "Add Google Auth",
  summary: "Auth integration",
  targetFiles: [{ path: "app/chat.tsx", action: "modify", rationale: "guard" }],
  acceptanceCriteriaMap: [
    {
      acId: "AC1",
      description: "Redirect unauthenticated users",
      testFile: "tests/chat-auth.test.ts",
      testCaseName: "redirects to login",
    },
  ],
} as ExecutionPlan;

/** The ACs pass, so the run reaches the review-budget path rather than the AC-verification one. */
function task(): DefinitionOfDoneTask {
  return {
    runId: "run-691",
    repo: "org/repo",
    issue: 179,
    head: "task-branch",
    title: "Add Google Auth",
    body: "Closes #179",
    plan,
    testResults: [
      { testFile: "tests/chat-auth.test.ts", testCaseName: "redirects to login", passed: true },
    ],
  };
}

/** No disposition for the finding, so the review rounds exhaust rather than the run succeeding. */
function depsWith(runChecks: unknown): DefinitionOfDoneDeps {
  return {
    prWriter: {
      createPullRequest: vi.fn().mockResolvedValue({
        ok: true,
        pr: { number: 100, url: "https://github.com/org/repo/pull/100", head: "task-branch", base: "main" },
      }),
    },
    commentWriter: { postComment: vi.fn().mockResolvedValue({ ok: true }) },
    runChecks: runChecks as DefinitionOfDoneDeps["runChecks"],
    attemptFixes: vi.fn().mockResolvedValue([]),
  } as DefinitionOfDoneDeps;
}

describe("#691 an unfinished check is not a failure", () => {
  it("names the checks that had not finished, as a reason the machine can read", async () => {
    const deps = depsWith(
      vi.fn().mockResolvedValue(
        checkRunFindings([{ name: "e2e", status: "in_progress", conclusion: null }] as never),
      ),
    );

    const result = await runDefinitionOfDone(deps, task());

    expect(result.blockedReason).toBe("checks-not-finished");
    expect(result.pendingChecks).toEqual(["e2e"]);
  });

  it("does NOT report checks-not-finished when a check actually FAILED", async () => {
    // The two cases must not collapse. A failed check is real evidence against the work, and
    // reporting it as "still running" would launder a failure into a delay.
    const deps = depsWith(
      vi.fn().mockResolvedValue(
        checkRunFindings([{ name: "MegaLinter", status: "completed", conclusion: "failure" }] as never),
      ),
    );

    const result = await runDefinitionOfDone(deps, task());

    expect(result.blockedReason).not.toBe("checks-not-finished");
    expect(result.pendingChecks ?? []).toEqual([]);
  });

  it("CONTROL: reports the FAILURE when both a failed and an unfinished check are present", async () => {
    const deps = depsWith(
      vi.fn().mockResolvedValue(
        checkRunFindings([
          { name: "e2e", status: "in_progress", conclusion: null },
          { name: "MegaLinter", status: "completed", conclusion: "failure" },
        ] as never),
      ),
    );

    const result = await runDefinitionOfDone(deps, task());

    expect(result.blockedReason).not.toBe("checks-not-finished");
  });

  it("CONTROL: the run is still NOT certified done while a check is unsettled", async () => {
    // 659 Stage 3 exists so a run cannot claim done against an outcome it cannot see. This change
    // must not weaken it: the run is still blocked, it simply says why.
    const deps = depsWith(
      vi.fn().mockResolvedValue(
        checkRunFindings([{ name: "e2e", status: "in_progress", conclusion: null }] as never),
      ),
    );

    const result = await runDefinitionOfDone(deps, task());

    expect(result.status).not.toBe("done");
    expect(result.ok).toBe(false);
  });


  it("CONTROL: a run blocked by a history failure reports no check deferral", async () => {
    // The deferral fields say "the checks are the only thing in the way". A ledger failure is a
    // different obstacle, so the fields must be absent - never left behind from an earlier result,
    // contradicting the reason right beside them.
    const deps = depsWith(
      vi.fn().mockResolvedValue(
        checkRunFindings([{ name: "e2e", status: "in_progress", conclusion: null }] as never),
      ),
    ) as DefinitionOfDoneDeps & { runHistory?: unknown };
    deps.runHistory = {
      listRunEvents: async () => ({ ok: false, error: "history boom" }),
    } as never;

    const result = await runDefinitionOfDone(deps, task());

    expect(result.reason).toContain("Run history persistence failed");
    expect(result.blockedReason).toBeUndefined();
    expect(result.pendingChecks).toBeUndefined();
  });

  it("the pure helper withholds the reason when anything else is unresolved", () => {
    // Fail-closed: an unresolved review finding means the run is not merely waiting.
    expect(unfinishedChecks([]).blockedReason).toBeUndefined();
    expect(
      unfinishedChecks([
        { id: "PR-CHECK-UNSETTLED:e2e", source: "linter", message: "not finished" },
        { id: "PR-CHECK-FAILED:MegaLinter", source: "linter", message: "failed" },
      ]).blockedReason,
    ).toBeUndefined();
    expect(
      unfinishedChecks([
        { id: "PR-CHECK-UNSETTLED:e2e", source: "linter", message: "not finished" },
        { id: "CODE-1", source: "pr-reviewer", message: "extract this" },
      ]).blockedReason,
    ).toBeUndefined();
    // and the positive case, so the three assertions above cannot pass by refusing everything
    expect(
      unfinishedChecks([
        { id: "PR-CHECK-UNSETTLED:b", source: "linter", message: "not finished" },
        { id: "PR-CHECK-UNSETTLED:a", source: "linter", message: "not finished" },
      ]),
    ).toEqual({ blockedReason: "checks-not-finished", pendingChecks: ["a", "b"] });
  });
});
