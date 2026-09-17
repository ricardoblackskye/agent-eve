import { describe, it, expect } from "vitest";
import {
  toTaskAssignment,
  type TaskAssignment,
  type SkeletonMap,
  InvalidTaskError,
  runCodingLoop,
  applySkeletalMap,
  SkeletonMapError,
  ALLOWED_TOOLS,
  assertToolAllowed,
  ToolNotAllowedError,
  createDeveloperAgent,
} from "../../agent/lib/dark-factory/developer-agent";

// --- Task 133.1: Core types + TaskAssignment payload ---

describe("toTaskAssignment", () => {
  const validInput = {
    taskId: "task-1",
    description: "Add a helper that reverses strings",
    repo: "ricardoblackskye/agent-eve",
    ref: "main",
    skeletonMap: { "src/helpers.ts": "export function reverse(s: string): string {}" },
  };

  it("produces a valid TaskAssignment from complete input", () => {
    const result = toTaskAssignment(validInput);
    expect(result.taskId).toBe("task-1");
    expect(result.description).toBe("Add a helper that reverses strings");
    expect(result.repo).toBe("ricardoblackskye/agent-eve");
    expect(result.ref).toBe("main");
    expect(result.skeletonMap).toEqual(validInput.skeletonMap);
  });

  it("rejects missing taskId", () => {
    expect(() =>
      toTaskAssignment({ ...validInput, taskId: "" }),
    ).toThrow(InvalidTaskError);
  });

  it("rejects whitespace-only taskId", () => {
    expect(() =>
      toTaskAssignment({ ...validInput, taskId: "   " }),
    ).toThrow(InvalidTaskError);
  });

  it("rejects missing description", () => {
    expect(() =>
      toTaskAssignment({ ...validInput, description: "" }),
    ).toThrow(InvalidTaskError);
  });

  it("rejects missing repo", () => {
    expect(() =>
      toTaskAssignment({ ...validInput, repo: "" }),
    ).toThrow(InvalidTaskError);
  });

  it("rejects unknown taskId format", () => {
    expect(() =>
      toTaskAssignment({ ...validInput, taskId: "!!invalid id!!" }),
    ).toThrow(InvalidTaskError);
  });

  it("rejects a repo string without owner/name shape", () => {
    expect(() =>
      toTaskAssignment({ ...validInput, repo: "not-a-repo" }),
    ).toThrow(InvalidTaskError);
  });

  it("defaults ref to main when omitted", () => {
    const { ref, ...rest } = validInput;
    const result = toTaskAssignment(rest as any);
    expect(result.ref).toBe("main");
  });

  it("defaults skeletonMap to empty object when omitted", () => {
    const { skeletonMap, ...rest } = validInput;
    const result = toTaskAssignment(rest as any);
    expect(result.skeletonMap).toEqual({});
  });
});

// --- Task 133.2: TDD coding loop (fail → fix → pass) ---

describe("runCodingLoop", () => {
  it("returns success on first passing iteration", async () => {
    const result = await runCodingLoop({
      maxIterations: 5,
      worker: async () => ({ passed: true }),
    });
    expect(result.status).toBe("success");
    expect(result.iterations).toBe(1);
    expect(result.fixCycles).toBe(0);
  });

  it("iterates until tests pass (fail → fail → pass)", async () => {
    let calls = 0;
    const result = await runCodingLoop({
      maxIterations: 5,
      worker: async () => {
        calls++;
        return { passed: calls >= 3 };
      },
    });
    expect(result.status).toBe("success");
    expect(result.iterations).toBe(3);
    expect(result.fixCycles).toBe(2);
  });

  it("returns failed when max iterations reached without passing", async () => {
    const result = await runCodingLoop({
      maxIterations: 3,
      worker: async () => ({ passed: false }),
    });
    expect(result.status).toBe("failed");
    expect(result.iterations).toBe(3);
    expect(result.fixCycles).toBe(3);
  });

  it("never exceeds the iteration cap", async () => {
    let calls = 0;
    const result = await runCodingLoop({
      maxIterations: 2,
      worker: async () => {
        calls++;
        return { passed: false };
      },
    });
    expect(calls).toBe(2);
    expect(result.iterations).toBe(2);
    expect(result.status).toBe("failed");
  });

  it("passes the iteration index to the worker", async () => {
    const seen: number[] = [];
    await runCodingLoop({
      maxIterations: 3,
      worker: async (ctx) => {
        seen.push(ctx.iteration);
        return { passed: ctx.iteration === 3 };
      },
    });
    expect(seen).toEqual([1, 2, 3]);
  });
});

// --- Task 133.3: Worker lifecycle integration (AC3) ---

describe("applySkeletalMap", () => {
  it("writes skeleton files into the workspace", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { rmSync, readFileSync, existsSync } = await import("node:fs");
    const { stat } = await import("node:fs/promises");

    const dir = mkdtempSync(join(tmpdir(), "df-sk-"));
    try {
      const map: SkeletonMap = {
        "src/helper.ts": "export function helper() {}",
        "tests/helper.test.ts": "test('x', () => {});",
      };
      await applySkeletalMap(dir, map);

      expect(existsSync(join(dir, "src/helper.ts"))).toBe(true);
      expect(readFileSync(join(dir, "src/helper.ts"), "utf8")).toBe(
        "export function helper() {}",
      );
      expect(existsSync(join(dir, "tests/helper.test.ts"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects writes outside the workspace (path traversal)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { rmSync } = await import("node:fs");

    const dir = mkdtempSync(join(tmpdir(), "df-sk-"));
    try {
      const map: SkeletonMap = {
        "../../etc/passwd": "evil",
      };
      await expect(applySkeletalMap(dir, map)).rejects.toThrow(SkeletonMapError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths in the skeleton map", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { rmSync } = await import("node:fs");

    const dir = mkdtempSync(join(tmpdir(), "df-sk-"));
    try {
      const map: SkeletonMap = {
        "/abs/path.ts": "code",
      };
      await expect(applySkeletalMap(dir, map)).rejects.toThrow(SkeletonMapError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- Task 133.4: Tool confinement (AC4) ---

describe("Tool confinement", () => {
  it("allows only the four sanctioned tools", () => {
    expect(ALLOWED_TOOLS.has("git_clone")).toBe(true);
    expect(ALLOWED_TOOLS.has("read_file")).toBe(true);
    expect(ALLOWED_TOOLS.has("write_code")).toBe(true);
    expect(ALLOWED_TOOLS.has("run_tests")).toBe(true);
  });

  it("rejects any non-allowlisted tool", () => {
    expect(ALLOWED_TOOLS.has("exec")).toBe(false);
    expect(ALLOWED_TOOLS.has("curl")).toBe(false);
    expect(ALLOWED_TOOLS.has("rm")).toBe(false);
  });

  it("throws ToolNotAllowed for an unsanctioned tool call", () => {
    expect(() => assertToolAllowed("curl")).toThrow(ToolNotAllowedError);
  });

  it("does not throw for a sanctioned tool call", () => {
    expect(() => assertToolAllowed("read_file")).not.toThrow();
    expect(() => assertToolAllowed("write_code")).not.toThrow();
  });
});

// --- Task 133.5: Metrics integration (observability) ---

describe("recordIteration (metrics)", () => {
  it("records a completed iteration to the MetricsStore", async () => {
    const { InMemoryMetricsStore } = await import("../../agent/lib/dark-factory/metrics");
    const store = new InMemoryMetricsStore();
    const agent = createDeveloperAgent({ metrics: store });

    await agent.recordIteration({
      taskId: "task-1",
      iterations: 3,
      fixCycles: 2,
      status: "success",
    });

    const records = store.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      taskType: "developer",
      iterations: 3,
      fixCycles: 2,
      status: "success",
    });
  });

  it("tracks success rate per task type", async () => {
    const { InMemoryMetricsStore } = await import("../../agent/lib/dark-factory/metrics");
    const store = new InMemoryMetricsStore();
    const agent = createDeveloperAgent({ metrics: store });

    await agent.recordIteration({
      taskId: "t1",
      iterations: 1,
      fixCycles: 0,
      status: "success",
    });
    await agent.recordIteration({
      taskId: "t2",
      iterations: 5,
      fixCycles: 4,
      status: "failure",
    });

    expect(store.successRateByType("developer")).toBe(0.5);
  });

  it("throws InvalidTaskError on invalid status value", async () => {
    const { InMemoryMetricsStore } = await import("../../agent/lib/dark-factory/metrics");
    const store = new InMemoryMetricsStore();
    const agent = createDeveloperAgent({ metrics: store });

    await expect(
      agent.recordIteration({
        taskId: "t1",
        iterations: 1,
        fixCycles: 0,
        status: "weird" as any,
      }),
    ).rejects.toThrow(InvalidTaskError);
  });
});
