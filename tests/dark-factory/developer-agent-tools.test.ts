import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorkspaceTools,
  runMultiFileCodingLoop,
} from "../../agent/lib/dark-factory/developer-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

describe("Developer Agent Multi-File Workspace Tools", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "df-dev-tools-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("safely reads and writes files within the workspace root", async () => {
    const tools = createWorkspaceTools(tempDir);
    await tools.writeFile("app/test.ts", "export const x = 42;");
    const content = await tools.readFile("app/test.ts");
    expect(content).toBe("export const x = 42;");
  });

  it("throws error and blocks path traversal attempts", async () => {
    const tools = createWorkspaceTools(tempDir);
    await expect(tools.readFile("../escape.txt")).rejects.toThrow(/rejected|traversal/i);
    await expect(tools.writeFile("../escape.txt", "evil")).rejects.toThrow(/rejected|traversal/i);
  });

  it("executes tests using commandRunner and reports pass/fail", async () => {
    const mockRunner = vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "Tests passed",
      stderr: "",
    });

    const tools = createWorkspaceTools(tempDir, mockRunner);
    const result = await tools.runTests("npx vitest run tests/chat.test.ts");
    expect(result.passed).toBe(true);
    expect(result.output).toBe("Tests passed");
    expect(mockRunner).toHaveBeenCalledWith("npx vitest run tests/chat.test.ts");
  });

  it("drives runMultiFileCodingLoop until tests pass", async () => {
    const tools = createWorkspaceTools(tempDir);
    const plan: ExecutionPlan = {
      storyId: 179,
      title: "Test Story",
      summary: "Test Summary",
      targetFiles: [{ path: "app/chat.tsx", action: "modify", rationale: "test" }],
      acceptanceCriteriaMap: [
        { acId: "AC1", description: "test ac", testFile: "tests/test.ts", testCaseName: "passes" },
      ],
    };

    let attempts = 0;
    const loopResult = await runMultiFileCodingLoop({
      plan,
      tools,
      maxIterations: 3,
      worker: async (ctx) => {
        attempts++;
        expect(ctx.plan).toBe(plan);
        expect(ctx.tools).toBe(tools);
        if (ctx.iteration < 2) {
          return { passed: false, output: "Iteration 1 failure" };
        }
        return { passed: true };
      },
    });

    expect(loopResult.status).toBe("success");
    expect(loopResult.iterations).toBe(2);
    expect(loopResult.fixCycles).toBe(1);
    expect(attempts).toBe(2);
  });
});
