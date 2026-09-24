/**
 * #164 — Dark Factory R5: definition of DONE.
 *
 * A task is done only when:
 * 1. A PR is opened on a task branch, linked to the issue (`Closes #<issue>`).
 * 2. Every automated finding is dispositioned (resolved via code change, or
 *    explicitly accepted with a reasoned explanation posted on the PR).
 * 3. The loop is bounded (`DF_MAX_REVIEW_ROUNDS`, digits-only, default 3).
 *    Recurring findings count against the budget (no reset).
 *    On exhaustion the task stops and becomes `df:blocked` / `needs-answer`.
 * 4. The factory MUST NEVER MERGE — opening the PR is the terminal action.
 */
import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_MAX_REVIEW_ROUNDS,
  InvalidConfigurationError,
  resolveMaxReviewRounds,
  runDefinitionOfDone,
  renderAcceptedFindingComment,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneTask,
  type PrCommentWriter,
  type PrOpener,
  type ReviewFinding,
  type FindingDisposition,
} from "../../agent/lib/dark-factory/definition-of-done";
import { GitHubPrWriter } from "../../agent/lib/dark-factory/pr-writer";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

describe("#164 cycle 1: resolveMaxReviewRounds — digits-only, fail-closed configuration", () => {
  it("exports DEFAULT_MAX_REVIEW_ROUNDS constant as 3", () => {
    expect(DEFAULT_MAX_REVIEW_ROUNDS).toBe(3);
  });

  it("defaults to 3 when DF_MAX_REVIEW_ROUNDS is unset or empty", () => {
    expect(resolveMaxReviewRounds({})).toBe(3);
    expect(resolveMaxReviewRounds({ DF_MAX_REVIEW_ROUNDS: "" })).toBe(3);
    expect(resolveMaxReviewRounds({ DF_MAX_REVIEW_ROUNDS: "   " })).toBe(3);
  });

  it("parses valid positive integer digits", () => {
    expect(resolveMaxReviewRounds({ DF_MAX_REVIEW_ROUNDS: "1" })).toBe(1);
    expect(resolveMaxReviewRounds({ DF_MAX_REVIEW_ROUNDS: "5" })).toBe(5);
    expect(resolveMaxReviewRounds({ DF_MAX_REVIEW_ROUNDS: " 10 " })).toBe(10);
  });

  it("throws InvalidConfigurationError for malformed inputs (scientific notation, hex, negative, zero, floats, non-digits)", () => {
    const invalidValues = [
      "1e3",
      "0x10",
      "-1",
      "0",
      "3.5",
      "abc",
      "five",
      "1a",
    ];
    for (const val of invalidValues) {
      expect(() =>
        resolveMaxReviewRounds({ DF_MAX_REVIEW_ROUNDS: val }),
      ).toThrow(InvalidConfigurationError);
      expect(() =>
        resolveMaxReviewRounds({ DF_MAX_REVIEW_ROUNDS: val }),
      ).toThrow(
        /DF_MAX_REVIEW_ROUNDS must be a positive integer \(digits only/i,
      );
    }
  });
});

describe("#164 cycle 2: createPullRequest — opened on task branch, linked to issue, fail-closed", () => {
  const allowedEnv = {
    DF_WORKER_ALLOWED_REPOS: "ricardoblackskye/agent-eve",
    GITHUB_TOKEN: "gh_test_token",
  };

  it("opens a PR linked to the issue with Closes #<issue>", async () => {
    const recordedCalls: { url: string; body: any }[] = [];
    const fakeFetch = (async (url: string, init: any) => {
      recordedCalls.push({ url, body: JSON.parse(init.body) });
      return {
        ok: true,
        status: 201,
        json: async () => ({
          number: 175,
          html_url: "https://github.com/ricardoblackskye/agent-eve/pull/175",
        }),
      };
    }) as any;

    const writer = new GitHubPrWriter({
      token: "gh_test_token",
      fetchImpl: fakeFetch,
      env: allowedEnv,
    });

    const res = await writer.createPullRequest(
      "ricardoblackskye",
      "agent-eve",
      {
        title: "feat: autonomous task output",
        head: "feat/task-164",
        base: "main",
        body: "Implements the requested feature.",
        issue: 164,
      },
    );

    expect(res.ok).toBe(true);
    expect(res.pr?.number).toBe(175);
    expect(res.pr?.url).toBe(
      "https://github.com/ricardoblackskye/agent-eve/pull/175",
    );
    expect(recordedCalls).toHaveLength(1);
    expect(recordedCalls[0].url).toBe(
      "https://api.github.com/repos/ricardoblackskye/agent-eve/pulls",
    );
    expect(recordedCalls[0].body.body).toContain("Closes #164");
    expect(recordedCalls[0].body.head).toBe("feat/task-164");
    expect(recordedCalls[0].body.base).toBe("main");
  });

  it("REFUSES repos outside DF_WORKER_ALLOWED_REPOS (fail-closed)", async () => {
    const fakeFetch = vi.fn();
    const writer = new GitHubPrWriter({
      token: "gh_test_token",
      fetchImpl: fakeFetch as any,
      env: allowedEnv,
    });

    const res = await writer.createPullRequest("someone", "other-repo", {
      title: "unauthorized PR",
      head: "feat/bad",
      base: "main",
      body: "evil",
      issue: 1,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/DF_WORKER_ALLOWED_REPOS/);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("REFUSES when DF_WORKER_ALLOWED_REPOS or token is missing", async () => {
    const fakeFetch = vi.fn();
    const noRepoWriter = new GitHubPrWriter({
      token: "gh_test_token",
      fetchImpl: fakeFetch as any,
      env: {},
    });
    const noRepoRes = await noRepoWriter.createPullRequest(
      "ricardoblackskye",
      "agent-eve",
      {
        title: "no repos",
        head: "feat/x",
        body: "body",
        issue: 1,
      },
    );
    expect(noRepoRes.ok).toBe(false);
    expect(noRepoRes.error).toMatch(/DF_WORKER_ALLOWED_REPOS/);

    const noTokenWriter = new GitHubPrWriter({
      fetchImpl: fakeFetch as any,
      env: { DF_WORKER_ALLOWED_REPOS: "ricardoblackskye/agent-eve" },
    });
    const noTokenRes = await noTokenWriter.createPullRequest(
      "ricardoblackskye",
      "agent-eve",
      {
        title: "no token",
        head: "feat/x",
        body: "body",
        issue: 1,
      },
    );
    expect(noTokenRes.ok).toBe(false);
    expect(noTokenRes.error).toMatch(/token/i);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("validates repository owner and name format (rejecting injection attempts)", async () => {
    const fakeFetch = vi.fn();
    const writer = new GitHubPrWriter({
      token: "gh_test_token",
      fetchImpl: fakeFetch as any,
      env: allowedEnv,
    });

    const badOwner = await writer.createPullRequest(
      "bad/owner/traversal",
      "agent-eve",
      { title: "t", head: "h", body: "b", issue: 1 },
    );
    expect(badOwner.ok).toBe(false);
    expect(badOwner.error).toMatch(/Invalid repository owner.*or name/i);

    const badRepo = await writer.createPullRequest(
      "ricardoblackskye",
      "agent;drop table",
      { title: "t", head: "h", body: "b", issue: 1 },
    );
    expect(badRepo.ok).toBe(false);
    expect(badRepo.error).toMatch(/Invalid repository owner.*or name/i);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("handles non-Error thrown objects safely during fetch", async () => {
    const fakeFetch = () => Promise.reject("raw network failure string");
    const writer = new GitHubPrWriter({
      token: "gh_test_token",
      fetchImpl: fakeFetch as any,
      env: allowedEnv,
    });

    const res = await writer.createPullRequest(
      "ricardoblackskye",
      "agent-eve",
      { title: "t", head: "h", body: "b", issue: 1 },
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe("raw network failure string");
  });
});

describe("#164 cycles 3-10: runDefinitionOfDone coordinator", () => {
  function setupTestDeps(over: Partial<DefinitionOfDoneDeps> = {}) {
    const prs: any[] = [];
    const comments: { prNumber: number; body: string }[] = [];
    const labels: { op: string; label: string }[] = [];

    const prWriter: PrOpener = {
      createPullRequest: async (owner, repo, opts) => {
        const pr = {
          number: 101,
          url: `https://github.com/${owner}/${repo}/pull/101`,
          head: opts.head,
          base: opts.base || "main",
          title: opts.title,
          body: opts.body,
        };
        prs.push(pr);
        return { ok: true, pr };
      },
    };

    const commentWriter: PrCommentWriter = {
      postComment: async (_o, _r, prNumber, body) => {
        comments.push({ prNumber, body });
        return { ok: true };
      },
    };

    const labelWriter = {
      add: async (_r: string, _i: number, label: string) => {
        labels.push({ op: "add", label });
        return { ok: true };
      },
      remove: async (_r: string, _i: number, label: string) => {
        labels.push({ op: "remove", label });
        return { ok: true };
      },
    };

    return {
      prs,
      comments,
      labels,
      deps: {
        prWriter,
        commentWriter,
        labelWriter,
        runChecks: async () => [],
        env: { DF_WORKER_ALLOWED_REPOS: "ricardoblackskye/agent-eve" },
        ...over,
      } as DefinitionOfDoneDeps,
    };
  }

  const sampleTask: DefinitionOfDoneTask = {
    runId: "ricardoblackskye/agent-eve#164",
    repo: "ricardoblackskye/agent-eve",
    issue: 164,
    head: "feat/task-164",
    title: "Dark Factory task implementation",
    body: "Implemented autonomous task.",
  };

  it("cycle 3: clean run with 0 findings opens PR and marks task done immediately", async () => {
    const { prs, deps } = setupTestDeps({
      runChecks: async () => [],
    });

    const result = await runDefinitionOfDone(deps, sampleTask);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(result.roundsExecuted).toBe(1);
    expect(result.totalFindings).toBe(0);
    expect(result.remainingFindings).toHaveLength(0);
    expect(result.pr?.number).toBe(101);
    expect(result.pr?.url).toBe(
      "https://github.com/ricardoblackskye/agent-eve/pull/101",
    );
    expect(prs).toHaveLength(1);
  });

  it("persists PR, review-round, and terminal lifecycle events", async () => {
    const task = {
      ...sampleTask,
      runId: "run-history-dod",
      runMetrics: { iterationCount: 3, fixCycleCount: 1, latencyMs: 1200, costUsd: 0.03 },
    };
    const history = new SqliteRunHistoryStore(":memory:", () => task.runId);
    const accepted = await history.acceptDelivery({
      deliveryId: "delivery-dod",
      repo: task.repo,
      issue: task.issue,
      receivedAt: "2026-09-24T12:00:00.000Z",
    });
    expect(accepted.ok).toBe(true);

    const { deps } = setupTestDeps({
      runChecks: async () => [],
      runHistory: history,
    });

    const result = await runDefinitionOfDone(deps, task);
    const summary = await history.getRun(task.runId);
    const events = await history.listRunEvents(task.runId);

    expect(result.status, result.reason).toBe("done");
    expect(summary.value?.status).toBe("succeeded");
    expect(summary.value?.reviewCount).toBe(1);
    expect(summary.value?.iterationCount).toBe(3);
    expect(summary.value?.fixCycleCount).toBe(1);
    expect(summary.value?.latencyMs).toBe(1200);
    expect(summary.value?.costUsd).toBe(0.03);
    expect(summary.value?.prUrl).toBe(result.pr?.url);
    expect(events.value?.items.map(({ event }) => event.type)).toEqual([
      "run.accepted",
      "pr.opened",
      "review.round",
      "run.terminal",
    ]);
    await history.close();
  });

  it("records aggregate review findings and verified dispositions per round", async () => {
    const task = { ...sampleTask, runId: "run-history-dispositions" };
    const history = new SqliteRunHistoryStore(":memory:", () => task.runId);
    const accepted = await history.acceptDelivery({
      deliveryId: "delivery-dod-dispositions",
      repo: task.repo,
      issue: task.issue,
      receivedAt: "2026-09-24T12:00:00.000Z",
    });
    expect(accepted.ok).toBe(true);

    const finding: ReviewFinding = {
      id: "lint-1",
      source: "linter",
      message: "Unused declaration",
    };
    const { deps } = setupTestDeps({
      runChecks: async (round) => (round === 1 ? [finding] : []),
      attemptFixes: async () => [{ findingId: finding.id, status: "resolved" }],
      runHistory: history,
    });

    const result = await runDefinitionOfDone(deps, task);
    const events = await history.listRunEvents(task.runId);
    const rounds = events.value?.items
      .map(({ event }) => event)
      .filter((event) => event.type === "review.round");

    expect(result.status).toBe("done");
    expect(rounds).toEqual([
      expect.objectContaining({
        reviewRound: 1,
        findingCount: 1,
        resolvedCount: 0,
        acceptedCount: 0,
      }),
      expect.objectContaining({
        reviewRound: 2,
        findingCount: 0,
        resolvedCount: 1,
        acceptedCount: 0,
      }),
    ]);
    await history.close();
  });

  it("records accepted findings as aggregate counts without persisting raw finding text", async () => {
    const task = { ...sampleTask, runId: "run-history-accepted-disposition" };
    const history = new SqliteRunHistoryStore(":memory:", () => task.runId);
    const accepted = await history.acceptDelivery({
      deliveryId: "delivery-dod-accepted-disposition",
      repo: task.repo,
      issue: task.issue,
      receivedAt: "2026-09-24T12:00:00.000Z",
    });
    expect(accepted.ok).toBe(true);

    const finding: ReviewFinding = {
      id: "security-secret-finding-id",
      source: "codeql",
      message: "Raw secret-bearing explanation must not enter run history",
      severity: "warning",
    };
    const { deps } = setupTestDeps({
      runChecks: async () => [finding],
      attemptFixes: async () => [{
        findingId: finding.id,
        status: "accepted",
        explanation: "Accepted with a documented compensating control.",
      }],
      runHistory: history,
    });

    const result = await runDefinitionOfDone(deps, task);
    const events = await history.listRunEvents(task.runId);
    const review = events.value?.items.find((item) => item.event.type === "review.round")?.event;

    expect(result.status).toBe("done");
    expect(review).toMatchObject({ findingCount: 1, resolvedCount: 0, acceptedCount: 1 });
    expect(JSON.stringify(review)).not.toContain(finding.id);
    expect(JSON.stringify(review)).not.toContain(finding.message);
    await history.close();
  });

  it.each(["review-check", "fix-attempt"] as const)(
    "records a failed terminal event when a %s callback throws",
    async (failureStage) => {
      const task = { ...sampleTask, runId: `run-history-${failureStage}-failure` };
      const history = new SqliteRunHistoryStore(":memory:", () => task.runId);
      const accepted = await history.acceptDelivery({
        deliveryId: `delivery-${failureStage}-failure`,
        repo: task.repo,
        issue: task.issue,
        receivedAt: "2026-09-24T12:00:00.000Z",
      });
      expect(accepted.ok).toBe(true);
      const finding: ReviewFinding = {
        id: "review-failure",
        source: "test",
        message: "Synthetic review failure fixture",
      };
      const { deps } = setupTestDeps({
        runHistory: history,
        runChecks: async () => {
          if (failureStage === "review-check") throw new Error("review backend down");
          return [finding];
        },
        attemptFixes: async () => {
          throw new Error("fix backend down");
        },
      });

      const result = await runDefinitionOfDone(deps, task);
      const summary = await history.getRun(task.runId);
      const events = await history.listRunEvents(task.runId);
      const terminal = events.value?.items.find((item) => item.event.type === "run.terminal");

      expect(result.ok).toBe(false);
      expect(result.status).toBe("blocked");
      expect(summary.value?.status).toBe("failed");
      expect(terminal?.event.status).toBe("failed");
      await history.close();
    },
  );

  it("cycle 4: findings resolved via code change in subsequent round mark task done", async () => {
    let roundCalled = 0;
    const { deps } = setupTestDeps({
      runChecks: async (round) => {
        roundCalled = round;
        if (round === 1) {
          return [
            {
              id: "F1",
              source: "linter",
              message: "Unused variable 'x'",
              file: "src/index.ts",
              line: 12,
            },
          ];
        }
        return []; // Resolved in round 2!
      },
      attemptFixes: async (findings) => {
        return findings.map((f) => ({ findingId: f.id, status: "resolved" }));
      },
    });

    const result = await runDefinitionOfDone(deps, sampleTask);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(result.roundsExecuted).toBe(2);
    expect(result.resolvedCount).toBe(1);
    expect(result.acceptedCount).toBe(0);
    expect(result.remainingFindings).toHaveLength(0);
    expect(roundCalled).toBe(2);
  });

  it("cycle 5 & 6: explicitly accepted finding requires explanation and posts it to PR", async () => {
    const finding: ReviewFinding = {
      id: "SEC-1",
      source: "codeql",
      message: "Potential SSRF origin binding",
      file: "src/api.ts",
      line: 45,
    };

    const { comments, deps } = setupTestDeps({
      runChecks: async () => [finding],
      attemptFixes: async () => [
        {
          findingId: "SEC-1",
          status: "accepted",
          explanation:
            "Origin is strictly validated against localhost/127.0.0.1 in resolveApiOrigin; false positive.",
        },
      ],
    });

    const result = await runDefinitionOfDone(deps, sampleTask);

    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(result.acceptedCount).toBe(1);
    expect(result.remainingFindings).toHaveLength(0);
    expect(comments).toHaveLength(1);
    expect(comments[0].prNumber).toBe(101);
    expect(comments[0].body).toContain("SEC-1");
    expect(comments[0].body).toContain("resolveApiOrigin");
  });

  it("blocks an accepted finding when its PR explanation comment cannot be persisted", async () => {
    const finding: ReviewFinding = {
      id: "SEC-COMMENT-FAIL",
      source: "codeql",
      message: "The accepted explanation must reach the PR.",
    };
    const { deps } = setupTestDeps({
      runChecks: async () => [finding],
      attemptFixes: async () => [{
        findingId: finding.id,
        status: "accepted",
        explanation: "A documented compensating control exists.",
      }],
      commentWriter: {
        postComment: async () => ({ ok: false, error: "PR comment write failed" }),
      },
    });

    const result = await runDefinitionOfDone(deps, sampleTask);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.acceptedCount).toBe(0);
    expect(result.reason).toMatch(/comment/i);
  });

  it("cycle 6: accepted disposition without explanation is rejected (validation error)", async () => {
    const finding: ReviewFinding = {
      id: "SEC-2",
      source: "codeql",
      message: "Unescaped output",
    };

    const { deps } = setupTestDeps({
      runChecks: async () => [finding],
      attemptFixes: async () => [
        {
          findingId: "SEC-2",
          status: "accepted",
          explanation: "", // Missing explanation!
        },
      ],
    });

    const result = await runDefinitionOfDone(deps, sampleTask);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.reason).toMatch(/requires a non-empty explanation/i);
  });

  it("cycle 7: recurring findings count against budget without resetting round counter", async () => {
    const recurringFinding: ReviewFinding = {
      id: "TEST-FAIL",
      source: "test",
      message: "Expected 200 received 500",
    };

    let roundsRan = 0;
    const { deps } = setupTestDeps({
      env: { DF_MAX_REVIEW_ROUNDS: "2" },
      runChecks: async (r) => {
        roundsRan = r;
        return [recurringFinding]; // Always fails!
      },
      attemptFixes: async (findings) => {
        return findings.map((f) => ({ findingId: f.id, status: "resolved" }));
      },
    });

    const result = await runDefinitionOfDone(deps, sampleTask);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(roundsRan).toBe(2);
    expect(result.roundsExecuted).toBe(2);
    expect(result.remainingFindings).toHaveLength(1);
  });

  it("cycle 8: budget exhaustion halts loop, marks status blocked, and applies needs-answer label", async () => {
    const finding: ReviewFinding = {
      id: "BUG-1",
      source: "pr-reviewer",
      message: "Infinite recursion possibility",
    };

    const { labels, deps } = setupTestDeps({
      env: { DF_MAX_REVIEW_ROUNDS: "3" },
      runChecks: async () => [finding],
      attemptFixes: async () => [], // No fix produced
    });

    const result = await runDefinitionOfDone(deps, sampleTask);

    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.roundsExecuted).toBe(3);
    expect(result.reason).toMatch(/exhausted/i);
    expect(labels).toContainEqual({ op: "add", label: "needs-answer" });
  });

  it("cycle 9: renderAcceptedFindingComment produces attributable markdown on PR", () => {
    const finding: ReviewFinding = {
      id: "LINT-42",
      source: "linter",
      message: "Line exceeds 120 characters",
      file: "docs/readme.md",
      line: 88,
    };
    const comment = renderAcceptedFindingComment(
      finding,
      "Documentation line formatting preserved for tabular alignment.",
    );

    expect(comment).toContain("🤖 **Eve** (Dark Factory)");
    expect(comment).toContain("Finding Accepted");
    expect(comment).toContain("LINT-42");
    expect(comment).toContain("docs/readme.md#88");
    expect(comment).toContain("Documentation line formatting preserved");
    expect(comment).toMatch(/human reviewer.*final call/i);
  });

  it("cycle 10: non-merge invariant — factory NEVER merges pull requests", async () => {
    const writer = new GitHubPrWriter();
    // Verify no merge method exists on the writer
    expect((writer as any).mergePullRequest).toBeUndefined();
    expect((writer as any).merge).toBeUndefined();

    // Verify DoD result exposes no merge action
    const { deps } = setupTestDeps();
    const result = await runDefinitionOfDone(deps, sampleTask);
    expect((result as any).merged).toBeUndefined();
  });
});
