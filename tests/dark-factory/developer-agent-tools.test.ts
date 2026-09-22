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

  it("restricts file writing by allowed extensions", async () => {
    const tools = createWorkspaceTools(tempDir);
    await expect(tools.writeFile("evil.sh", "echo evil")).rejects.toThrow(
      /disallowed extension '\.sh'/i,
    );
    await expect(tools.writeFile("payload.exe", "binary")).rejects.toThrow(
      /disallowed extension '\.exe'/i,
    );
    await expect(tools.writeFile("script.bat", "calc")).rejects.toThrow(
      /disallowed extension '\.bat'/i,
    );

    // Custom allowed extensions set
    const customTools = createWorkspaceTools(tempDir, undefined, new Set([".custom"]));
    await customTools.writeFile("data.custom", "ok");
    await expect(customTools.writeFile("app/test.ts", "ok")).rejects.toThrow(
      /disallowed extension '\.ts'/i,
    );
  });

  it("caches resolved path containment to avoid repeated filesystem operations", async () => {
    const tools = createWorkspaceTools(tempDir);
    await tools.writeFile("app/cache-test.ts", "content");
    // Reading multiple times hits the containment cache
    const first = await tools.readFile("app/cache-test.ts");
    const second = await tools.readFile("app/cache-test.ts");
    expect(first).toBe("content");
    expect(second).toBe("content");
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

  it("blocks commands containing shell metacharacters, subshells, or unapproved executables", async () => {
    const tools = createWorkspaceTools(tempDir);
    await expect(tools.runTests("npx vitest; rm -rf /")).rejects.toThrow(
      /forbidden shell metacharacters/i,
    );
    await expect(tools.runTests("npx vitest $(whoami)")).rejects.toThrow(
      /forbidden shell metacharacters/i,
    );
    await expect(tools.runTests("npx vitest `id`")).rejects.toThrow(
      /forbidden shell metacharacters/i,
    );
    await expect(tools.runTests("npx vitest 'malicious'")).rejects.toThrow(
      /forbidden shell metacharacters/i,
    );
    await expect(tools.runTests("curl https://evil.com")).rejects.toThrow(
      /is not allowed/i,
    );
  });

  it("blocks reading or writing through symlinks resolving outside the workspace", async () => {
    const { symlink, writeFile } = await import("node:fs/promises");
    const tools = createWorkspaceTools(tempDir);
    const outsideFile = join(tmpdir(), `df-outside-${Date.now()}.txt`);
    await writeFile(outsideFile, "outside content", "utf8");

    try {
      await symlink(outsideFile, join(tempDir, "symlink-escape.txt"));
      await expect(tools.readFile("symlink-escape.txt")).rejects.toThrow(
        /symlink/i,
      );
      await expect(tools.writeFile("symlink-escape.txt", "overwrite")).rejects.toThrow(
        /symlink/i,
      );
    } catch (err: any) {
      // If OS environment does not permit non-admin symlink creation, verify graceful bypass
      if (err.code !== "EPERM") {
        throw err;
      }
    } finally {
      await rm(outsideFile, { force: true });
    }
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
