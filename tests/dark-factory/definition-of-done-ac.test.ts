import { describe, it, expect, vi } from "vitest";
import {
  runDefinitionOfDone,
  renderAcTraceabilityTable,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneTask,
} from "../../agent/lib/dark-factory/definition-of-done";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

describe("Definition of Done — Acceptance Criteria Traceability & Anti-Rubber-Stamp", () => {
  const plan: ExecutionPlan = {
    storyId: 179,
    title: "Google Auth Story",
    summary: "Auth integration",
    targetFiles: [{ path: "app/chat.tsx", action: "modify", rationale: "guard" }],
    acceptanceCriteriaMap: [
      {
        acId: "AC1",
        description: "Redirect unauthenticated users",
        testFile: "tests/chat-auth.test.ts",
        testCaseName: "redirects to login",
      },
      {
        acId: "AC2",
        description: "Grant allowed user access",
        testFile: "tests/chat-auth.test.ts",
        testCaseName: "grants access for allowed email",
      },
    ],
  };

  const createMockDeps = (): {
    deps: DefinitionOfDoneDeps;
    postedComments: string[];
  } => {
    const postedComments: string[] = [];
    return {
      postedComments,
      deps: {
        prWriter: {
          createPullRequest: vi.fn().mockResolvedValue({
            ok: true,
            pr: {
              number: 100,
              url: "https://github.com/org/repo/pull/100",
              head: "task-branch",
              base: "main",
            },
          }),
        },
        commentWriter: {
          postComment: vi.fn().mockImplementation(async (_o, _r, _num, body) => {
            postedComments.push(body);
            return { ok: true };
          }),
        },
        runChecks: vi.fn().mockResolvedValue([]),
      },
    };
  };

  it("renders a markdown AC traceability table", () => {
    const matrix = [
      {
        acId: "AC1",
        description: "Redirect user",
        testFile: "tests/auth.test.ts",
        testCaseName: "redirects",
        passed: true,
      },
      {
        acId: "AC2",
        description: "Deny unauthorized",
        testFile: "tests/auth.test.ts",
        testCaseName: "denies",
        passed: false,
      },
    ];

    const table = renderAcTraceabilityTable(matrix);
    expect(table).toContain("Acceptance Criteria Traceability Matrix");
    expect(table).toContain("| `AC1` | Redirect user | `tests/auth.test.ts` | `redirects` | PASS ✅ |");
    expect(table).toContain("| `AC2` | Deny unauthorized | `tests/auth.test.ts` | `denies` | FAIL ❌ |");
  });

  it("succeeds and posts traceability table when all plan ACs pass", async () => {
    const { deps, postedComments } = createMockDeps();

    const task: DefinitionOfDoneTask = {
      runId: "run-1",
      repo: "org/repo",
      issue: 179,
      head: "task-branch",
      title: "Add Google Auth",
      body: "Closes #179",
      plan,
      testResults: [
        { testFile: "tests/chat-auth.test.ts", testCaseName: "redirects to login", passed: true },
        { testFile: "tests/chat-auth.test.ts", testCaseName: "grants access for allowed email", passed: true },
      ],
    };

    const result = await runDefinitionOfDone(deps, task);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
    expect(result.acMatrix).toHaveLength(2);
    expect(result.acMatrix?.every((m) => m.passed)).toBe(true);

    // Verify traceability table was posted in comments
    const hasTraceabilityComment = postedComments.some((c) =>
      c.includes("Acceptance Criteria Traceability Matrix"),
    );
    expect(hasTraceabilityComment).toBe(true);
  });

  it("fails DoD when any plan AC is missing or not passing", async () => {
    const { deps } = createMockDeps();

    const task: DefinitionOfDoneTask = {
      runId: "run-2",
      repo: "org/repo",
      issue: 179,
      head: "task-branch",
      title: "Add Google Auth",
      body: "Closes #179",
      plan,
      testResults: [
        // AC1 passes, but AC2 fails
        { testFile: "tests/chat-auth.test.ts", testCaseName: "redirects to login", passed: true },
        { testFile: "tests/chat-auth.test.ts", testCaseName: "grants access for allowed email", passed: false },
      ],
    };

    const result = await runDefinitionOfDone(deps, task);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("AC2");
    expect(result.reason).toContain("did not pass");
  });

  it("anti-rubber-stamp: rejects accepting findings with severity error", async () => {
    const { deps } = createMockDeps();
    // Review check returns an error finding
    deps.runChecks = vi.fn().mockResolvedValue([
      {
        id: "SECURITY-001",
        source: "linter",
        message: "Severe security violation",
        severity: "error",
      },
    ]);

    // Runner attempts to blindly accept the error finding
    deps.attemptFixes = vi.fn().mockResolvedValue([
      {
        findingId: "SECURITY-001",
        status: "accepted",
        explanation: "Accepting blindly",
      },
    ]);

    const task: DefinitionOfDoneTask = {
      runId: "run-3",
      repo: "org/repo",
      issue: 179,
      head: "task-branch",
      title: "Add Google Auth",
      body: "Closes #179",
    };

    const result = await runDefinitionOfDone(deps, task);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("cannot accept findings with severity 'error'");
  });

  it("collects all error severity findings across dispositions before blocking", async () => {
    const { deps } = createMockDeps();
    deps.runChecks = vi.fn().mockResolvedValue([
      { id: "ERR-1", source: "linter", message: "Error one", severity: "error" },
      { id: "ERR-2", source: "security", message: "Error two", severity: "error" },
    ]);

    deps.attemptFixes = vi.fn().mockResolvedValue([
      { findingId: "ERR-1", status: "accepted", explanation: "Explain 1" },
      { findingId: "ERR-2", status: "accepted", explanation: "Explain 2" },
    ]);

    const task: DefinitionOfDoneTask = {
      runId: "run-multi-err",
      repo: "org/repo",
      issue: 179,
      head: "task-branch",
      title: "Add Google Auth",
      body: "Closes #179",
    };

    const result = await runDefinitionOfDone(deps, task);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("ERR-1: Error one");
    expect(result.reason).toContain("ERR-2: Error two");
  });


  it("evaluates AC traceability as a pure component (SRP)", async () => {
    const { evaluateAcTraceability } = await import(
      "../../agent/lib/dark-factory/definition-of-done"
    );

    const testResults = [
      { testFile: "tests/chat-auth.test.ts", testCaseName: "redirects to login", passed: true },
      { testFile: "tests/chat-auth.test.ts", testCaseName: "grants access for allowed email", passed: true },
    ];

    const result = evaluateAcTraceability(plan, testResults);
    expect(result.allPassed).toBe(true);
    expect(result.matrix).toHaveLength(2);
    expect(result.failingAcs).toHaveLength(0);
  });

  it("gracefully ignores finding disposition when finding is not found", async () => {
    const { deps } = createMockDeps();
    deps.runChecks = vi.fn().mockResolvedValue([]);
    deps.attemptFixes = vi.fn().mockResolvedValue([
      {
        findingId: "NON-EXISTENT-FINDING",
        status: "accepted",
        explanation: "Some explanation",
      },
    ]);

    const task: DefinitionOfDoneTask = {
      runId: "run-4",
      repo: "org/repo",
      issue: 179,
      head: "task-branch",
      title: "Task with phantom finding",
      body: "Closes #179",
    };

    const result = await runDefinitionOfDone(deps, task);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("done");
  });

  it("exports table rendering and comment formatting from dedicated dod-presentation module", async () => {
    const presentation = await import("../../agent/lib/dark-factory/dod-presentation");
    expect(typeof presentation.renderAcTraceabilityTable).toBe("function");
    expect(typeof presentation.renderAcceptedFindingComment).toBe("function");

    const comment = presentation.renderAcceptedFindingComment(
      { id: "TEST-1", source: "linter", severity: "warning", message: "formatting warning", file: "app.ts", line: 10 },
      "Style choice",
    );
    expect(comment).toContain("TEST-1");
    expect(comment).toContain("app.ts#10");
    expect(comment).toContain("Style choice");
  });
});


