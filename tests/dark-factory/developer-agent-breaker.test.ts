import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CircuitTrippedError,
  createWorkspaceTools,
  runMultiFileCodingLoop,
  type CodingLoopBreaker,
} from "../../agent/lib/dark-factory/developer-agent";
import type { ExecutionPlan } from "../../agent/lib/dark-factory/plan-validator";
import { createCircuitBreaker } from "../../agent/lib/dark-factory/circuit-breaker";
import { createCodingLoopBreaker } from "../../agent/lib/dark-factory/breaker-wiring";

/**
 * The breaker charges `Math.ceil(durationMs / 60_000)` minutes, so a worker must consume at
 * least a millisecond of wall clock for a trip to be deterministic. A bare async function
 * measures ~0ms, which the breaker correctly charges as 0 minutes.
 */
const sleep = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

const PLAN: ExecutionPlan = {
  storyId: 312,
  title: "Wire the circuit breaker into the worker path",
  summary: "test",
  targetFiles: [{ path: "app/x.ts", action: "modify", rationale: "test" }],
  acceptanceCriteriaMap: [],
};

describe("coding loop circuit-breaker seam (#312)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "df-breaker-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("records one worker activity per completed iteration", async () => {
    const activities: { pbiId: string; durationMs: number; status: string }[] =
      [];
    const breaker: CodingLoopBreaker = {
      pbiId: "pbi-312",
      isTripped: () => false,
      recordActivity: (activity) => {
        activities.push(activity);
      },
    };

    const result = await runMultiFileCodingLoop({
      plan: PLAN,
      tools: createWorkspaceTools(tempDir),
      maxIterations: 3,
      breaker,
      worker: async ({ iteration }) => ({ passed: iteration === 2 }),
    });

    expect(result.status).toBe("success");
    expect(activities).toHaveLength(2);
    expect(activities.map((a) => a.pbiId)).toEqual(["pbi-312", "pbi-312"]);
    expect(activities.map((a) => a.status)).toEqual(["failure", "success"]);
    expect(activities.every((a) => a.durationMs >= 0)).toBe(true);
  });

  it("halts fail-closed before the next iteration once the breaker has tripped", async () => {
    const worker = vi.fn(async () => {
      await sleep();
      return { passed: false };
    });
    const breaker: CodingLoopBreaker = {
      pbiId: "pbi-312",
      // Trips as soon as one unit of work has been observed.
      isTripped: () => worker.mock.calls.length > 0,
      recordActivity: () => {},
    };

    await expect(
      runMultiFileCodingLoop({
        plan: PLAN,
        tools: createWorkspaceTools(tempDir),
        maxIterations: 5,
        breaker,
        worker,
      }),
    ).rejects.toBeInstanceOf(CircuitTrippedError);

    expect(worker).toHaveBeenCalledTimes(1);
  });

  it("halts rather than reporting success when the budget is exhausted on the final iteration", async () => {
    const breaker = createCircuitBreaker({
      DF_MAX_WORKER_MINUTES_PER_PBI: "1",
      DF_MIN_DURATION_MS: "0",
    });

    await expect(
      runMultiFileCodingLoop({
        plan: PLAN,
        tools: createWorkspaceTools(tempDir),
        maxIterations: 1,
        breaker: createCodingLoopBreaker(breaker, 312),
        worker: async () => {
          await sleep();
          return { passed: true };
        },
      }),
    ).rejects.toBeInstanceOf(CircuitTrippedError);
  });

  it("reaches a real trip end-to-end past the configured cap", async () => {
    const breaker = createCircuitBreaker({
      DF_MAX_WORKER_MINUTES_PER_PBI: "1",
      DF_MIN_DURATION_MS: "0",
    });
    const worker = vi.fn(async () => {
      await sleep();
      return { passed: false };
    });

    await expect(
      runMultiFileCodingLoop({
        plan: PLAN,
        tools: createWorkspaceTools(tempDir),
        maxIterations: 5,
        breaker: createCodingLoopBreaker(breaker, 312),
        worker,
      }),
    ).rejects.toBeInstanceOf(CircuitTrippedError);

    expect(worker).toHaveBeenCalledTimes(1);
    expect(breaker.isTripped("pbi-312")).toBe(true);
  });

  it("leaves the loop behaviour unchanged when no breaker is wired", async () => {
    const result = await runMultiFileCodingLoop({
      plan: PLAN,
      tools: createWorkspaceTools(tempDir),
      maxIterations: 3,
      worker: async ({ iteration }) => ({ passed: iteration === 2 }),
    });

    expect(result).toEqual({ status: "success", iterations: 2, fixCycles: 1 });
  });
});
