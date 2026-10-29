import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classifyTestRun,
  createWorkspaceTools,
  runMultiFileCodingLoop,
  type CodingLoopBreaker,
  type CommandRunnerFn,
} from "../../agent/lib/dark-factory/developer-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";

/**
 * #541 - a test command that could not even start is unmeasured, never a failure of the developer's work.
 *
 * The marker list is the risk surface: if it matched ordinary test output, a real failure would silently become
 * unmeasured and a broken run would look healthy. So the negative cases (a genuine failure, a passing run) are
 * asserted beside the positive ones.
 */
const PLAN: ExecutionPlan = {
  storyId: 312,
  title: "Wire the circuit breaker into the worker path",
  summary: "test",
  targetFiles: [{ path: "app/x.ts", action: "modify", rationale: "test" }],
  acceptanceCriteriaMap: [],
};

describe("#541 - classifyTestRun discriminates a startup failure from a real test result", () => {
  it("classifies the real live-run failure as did-not-start", () => {
    expect(classifyTestRun("Error: Cannot find package '@vitejs/plugin-react'")).toBe("did-not-start");
  });

  it("does NOT treat a test's own missing-import error as did-not-start (guards against over-matching)", () => {
    expect(classifyTestRun("Error: Cannot find module 'src/helper'")).toBe("ran");
  });

  it("classifies a config that will not load as did-not-start", () => {
    expect(classifyTestRun("Failed to load config from vite.config.ts")).toBe("did-not-start");
  });

  it("classifies a missing binary as did-not-start", () => {
    expect(classifyTestRun("sh: vitest: command not found")).toBe("did-not-start");
  });

  it("classifies a genuine failing test as ran (it must stay a failure)", () => {
    expect(classifyTestRun("FAIL src/app.test.ts > expected 1 to be 2\n × failed")).toBe("ran");
  });

  it("classifies a passing run as ran", () => {
    expect(classifyTestRun("Test Files  1 passed (1)\n Tests  3 passed")).toBe("ran");
  });
});

describe("#541 - runTests reports whether the command actually ran", () => {
  it("reports ran:false when the command could not start", async () => {
    const runner: CommandRunnerFn = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error: Cannot find package '@vitejs/plugin-react'",
    });
    const tools = createWorkspaceTools(await mkdtemp(join(tmpdir(), "df-cls-")), runner);

    const outcome = await tools.runTests("npx vitest run");

    expect(outcome.ran).toBe(false);
    expect(outcome.passed).toBe(false);
  });

  it("reports ran:true for a genuine failing test (a real failure, not a startup one)", async () => {
    const runner: CommandRunnerFn = async () => ({
      exitCode: 1,
      stdout: "FAIL src/app.test.ts > expected 1 to be 2",
      stderr: "",
    });
    const tools = createWorkspaceTools(await mkdtemp(join(tmpdir(), "df-cls-")), runner);

    const outcome = await tools.runTests("npx vitest run");

    expect(outcome.ran).toBe(true);
    expect(outcome.passed).toBe(false);
  });

  it("reports ran:true for a passing run", async () => {
    const runner: CommandRunnerFn = async () => ({
      exitCode: 0,
      stdout: "Test Files  1 passed (1)",
      stderr: "",
    });
    const tools = createWorkspaceTools(await mkdtemp(join(tmpdir(), "df-cls-")), runner);

    const outcome = await tools.runTests("npx vitest run");

    expect(outcome.ran).toBe(true);
    expect(outcome.passed).toBe(true);
  });
});

describe("#541 - an unmeasured iteration does not charge the developer's breaker", () => {
  it("records nothing against the breaker when the tests could not start", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "df-cls-"));
    try {
      const failures: number[] = [];
      const breaker: CodingLoopBreaker = {
        pbiId: "pbi-541",
        isTripped: () => failures.length >= 3,
        recordActivity: (a) => {
          if (a.status === "failure") failures.push(1);
        },
      };

      const result = await runMultiFileCodingLoop({
        plan: PLAN,
        tools: createWorkspaceTools(tempDir),
        maxIterations: 3,
        breaker,
        worker: async () => ({
          passed: false,
          output: "Cannot find package '@vitejs/plugin-react'",
          unmeasured: true,
        }),
      });

      // The run did not pass — the acceptance criteria were never verified — but our environment's failure must
      // not be charged to the developer, so the breaker records nothing.
      expect(result.status).toBe("failed");
      expect(failures).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
