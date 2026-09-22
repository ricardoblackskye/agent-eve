import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArchitectAgent } from "../../agent/lib/dark-factory/architect-agent";
import {
  validateExecutionPlan,
  type ExecutionPlan,
} from "../../agent/lib/dark-factory/plan-validator";
import {
  createWorkspaceTools,
  runMultiFileCodingLoop,
} from "../../agent/lib/dark-factory/developer-agent";
import {
  runDefinitionOfDone,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneTask,
} from "../../agent/lib/dark-factory/definition-of-done";

describe("Dark Factory E2E Hardened Pipeline Integration", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "df-pipeline-e2e-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("orchestrates the full hardened pipeline: Architect -> Validator -> Multi-File Developer -> AC DoD", async () => {
    const story = {
      number: 179,
      title: "Add Google Authentication to the Eve Chat",
      body: `
**Intent**
A user must authenticate via Google OAuth before accessing the Eve Chat UI.

**Acceptance Criteria**
- AC1: given an unauthenticated user navigates to the Eve Chat UI, when the page loads, then the user is redirected to a Google sign-in prompt
- AC2: given a user completes Google sign-in with the email cuillinguy@gmail.com, when authentication finishes, then the user is granted access to the Eve Chat UI
`,
    };

    const plannedExecution: ExecutionPlan = {
      storyId: 179,
      title: story.title,
      summary: "Add Google OAuth redirect and user session gating to Eve Chat",
      targetFiles: [
        { path: "app/chat.tsx", action: "modify", rationale: "Wrap chat with Google auth gate" },
        { path: "app/google-auth.ts", action: "create", rationale: "Token verification utility" },
      ],
      acceptanceCriteriaMap: [
        {
          acId: "AC1",
          description: "Redirect unauthenticated user",
          testFile: "tests/chat-auth.test.ts",
          testCaseName: "redirects unauthenticated user to Google OAuth",
        },
        {
          acId: "AC2",
          description: "Grant allowed user access",
          testFile: "tests/chat-auth.test.ts",
          testCaseName: "grants access for allowed email",
        },
      ],
    };

    // 1. Architect Planning
    const architectDeps = {
      listFiles: vi.fn().mockResolvedValue(["app/chat.tsx", "app/page.tsx", "package.json"]),
      generateText: vi.fn().mockResolvedValue(JSON.stringify(plannedExecution)),
    };
    const architect = new ArchitectAgent(architectDeps);
    const planResult = await architect.planStory(story);

    expect(planResult.ok).toBe(true);
    expect(planResult.plan).toBeDefined();
    const plan = planResult.plan!;

    // 2. Pre-flight Domain Validation
    const validation = validateExecutionPlan(plan, story.body);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);

    // 3. Multi-File Workspace Execution
    const tools = createWorkspaceTools(tempDir);
    const testResults = [
      {
        testFile: "tests/chat-auth.test.ts",
        testCaseName: "redirects unauthenticated user to Google OAuth",
        passed: true,
      },
      {
        testFile: "tests/chat-auth.test.ts",
        testCaseName: "grants access for allowed email",
        passed: true,
      },
    ];

    const loopResult = await runMultiFileCodingLoop({
      plan,
      tools,
      maxIterations: 2,
      worker: async (ctx) => {
        // Write the files planned by the architect
        for (const file of ctx.plan.targetFiles) {
          await ctx.tools.writeFile(file.path, `// Implementation for ${file.path}`);
        }
        return { passed: true };
      },
    });

    expect(loopResult.status).toBe("success");
    expect(await tools.readFile("app/chat.tsx")).toContain("Implementation for app/chat.tsx");
    expect(await tools.readFile("app/google-auth.ts")).toContain("Implementation for app/google-auth.ts");

    // 4. Definition of Done with AC Traceability Verification
    const postedComments: string[] = [];
    const dodDeps: DefinitionOfDoneDeps = {
      prWriter: {
        createPullRequest: vi.fn().mockResolvedValue({
          ok: true,
          pr: {
            number: 180,
            url: "https://github.com/org/repo/pull/180",
            head: "feat/hardened-flow",
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
    };

    const dodTask: DefinitionOfDoneTask = {
      runId: "run-pipeline-test",
      repo: "ricardoblackskye/agent-eve",
      issue: 179,
      head: "feat/hardened-flow",
      title: "feat(dark-factory): hardened architect planning and DoD",
      body: "Closes #179",
      plan,
      testResults,
    };

    const dodResult = await runDefinitionOfDone(dodDeps, dodTask);
    expect(dodResult.ok).toBe(true);
    expect(dodResult.status).toBe("done");
    expect(dodResult.acMatrix).toHaveLength(2);
    expect(dodResult.acMatrix?.every((item) => item.passed)).toBe(true);

    const prTraceabilityComment = postedComments.find((c) =>
      c.includes("Acceptance Criteria Traceability Matrix"),
    );
    expect(prTraceabilityComment).toBeDefined();
    expect(prTraceabilityComment).toContain("PASS ✅");
  });
});
