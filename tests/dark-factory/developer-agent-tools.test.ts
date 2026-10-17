import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorkspaceTools,
  runMultiFileCodingLoop,
} from "../../agent/lib/dark-factory/developer-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";
import { StoppedRunError } from "../../agent/lib/dark-factory/control-checkpoint";

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

  it("blocks writing to protected configuration and secret files like .env", async () => {
    const tools = createWorkspaceTools(tempDir);
    await expect(tools.writeFile(".env", "SECRET=123")).rejects.toThrow(
      /protected configuration\/secret file/i,
    );
    await expect(tools.writeFile(".env.local", "SECRET=123")).rejects.toThrow(
      /protected configuration\/secret file/i,
    );
    await expect(tools.writeFile("app/.env.production", "SECRET=123")).rejects.toThrow(
      /protected configuration\/secret file/i,
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

  it("sandboxes commands even when custom commandRunner is provided", async () => {
    const mockRunner = vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const tools = createWorkspaceTools(tempDir, mockRunner);

    await expect(tools.runTests("npx vitest; rm -rf /")).rejects.toThrow(
      /forbidden shell metacharacters/i,
    );
    await expect(tools.runTests("curl https://evil.com")).rejects.toThrow(
      /is not allowed/i,
    );
    expect(mockRunner).not.toHaveBeenCalled();
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

  // #396: the target-is-a-symlink guard above is only reachable when the TARGET path itself is a symlink,
  // and it is built there with a FILE symlink - which cannot be created on Windows without a privilege.
  // The catch above swallows that failure and the test still PASSES, so the guard has never run on
  // Windows and the suite has been reporting otherwise. Note also that /symlink/i above is satisfied by
  // EITHER symlink guard, so it never pinned which one refused. These two cases pin each reason, and the
  // first builds the condition with a DIRECTORY JUNCTION instead - freed of that privilege, so the guard
  // is exercised on both platforms.
  it("refuses a write whose TARGET is an escaping link, naming the target guard (#396)", async () => {
    const { symlink } = await import("node:fs/promises");
    const { existsSync, mkdtempSync, rmSync } = await import("node:fs");
    const outsideDir = mkdtempSync(join(tmpdir(), "df-396-out-"));
    const tools = createWorkspaceTools(tempDir);
    // A directory junction needs no privilege on Windows, unlike a file symlink, and `lstat` still reports
    // it as a symlink - so this builds the SAME condition here as it does on the CI platform.
    const linkType = process.platform === "win32" ? "junction" : "dir";

    try {
      // The link's NAME must carry an allowed extension: the extension allow-list is checked before the
      // symlink guards, so a link named `escape` is refused for its name and never reaches them.
      await symlink(outsideDir, join(tempDir, "escape.ts"), linkType);
      // A fixture that silently did not get created is how this guard went untested here; assert it.
      expect(existsSync(join(tempDir, "escape.ts"))).toBe(true);

      await expect(tools.writeFile("escape.ts", "pwned")).rejects.toThrow(
        /is a symlink resolving outside workspace/,
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("refuses a write THROUGH an escaping link, naming the ancestor guard (#396)", async () => {
    const { symlink } = await import("node:fs/promises");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const outsideDir = mkdtempSync(join(tmpdir(), "df-396-out-"));
    const tools = createWorkspaceTools(tempDir);
    const linkType = process.platform === "win32" ? "junction" : "dir";

    try {
      await symlink(outsideDir, join(tempDir, "escape"), linkType);
      await expect(tools.writeFile("escape/evil.ts", "pwned")).rejects.toThrow(
        /escapes workspace via directory symlink/,
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
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

  it("honors Stop after the final worker iteration before reporting success", async () => {
    const tools = createWorkspaceTools(tempDir);
    const plan: ExecutionPlan = {
      storyId: 179,
      title: "Test Story",
      summary: "Test Summary",
      targetFiles: [{ path: "app/chat.tsx", action: "modify", rationale: "test" }],
      acceptanceCriteriaMap: [],
    };
    let checkpoints = 0;
    await expect(runMultiFileCodingLoop({
      plan,
      tools,
      maxIterations: 1,
      checkpoint: async () => {
        checkpoints += 1;
        if (checkpoints === 2) throw new StoppedRunError();
      },
      worker: async () => ({ passed: true }),
    })).rejects.toBeInstanceOf(StoppedRunError);
  });

  it("checks the cooperative control checkpoint before each coding iteration", async () => {
    const tools = createWorkspaceTools(tempDir);
    const plan: ExecutionPlan = {
      storyId: 179,
      title: "Test Story",
      summary: "Test Summary",
      targetFiles: [{ path: "app/chat.tsx", action: "modify", rationale: "test" }],
      acceptanceCriteriaMap: [],
    };
    const checkpoints: number[] = [];
    const workers: number[] = [];
    const result = await runMultiFileCodingLoop({
      plan,
      tools,
      maxIterations: 3,
      checkpoint: async (iteration) => { checkpoints.push(iteration); },
      worker: async ({ iteration }) => {
        workers.push(iteration);
        return { passed: iteration === 2 };
      },
    });
    expect(result.status).toBe("success");
    expect(checkpoints).toEqual([1, 2, 2]);
    expect(workers).toEqual([1, 2]);
  });
});
