import { describe, expect, it } from "vitest";
import {
  FINISHED_RUN_STATUSES,
  PLAN_HISTORY_WINDOW,
  selectPlanHistory,
} from "../../agent/lib/dark-factory/plan-history";
import type { RunStatus, RunSummary } from "../../agent/lib/dark-factory/run-history";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: `run-${Math.random().toString(16).slice(2)}`,
    repo: "owner/repo",
    issue: 533,
    status: "succeeded" as RunStatus,
    stage: "trigger",
    createdAt: "2026-10-29T10:00:00.000Z",
    updatedAt: "2026-10-29T10:05:00.000Z",
    attemptCount: 1,
    reviewCount: 1,
    iterationCount: 2,
    fixCycleCount: 1,
    ...overrides,
  } as RunSummary;
}

describe("the plan history window (#533)", () => {
  it("keeps runs that finished, whichever way they finished", () => {
    const kept = selectPlanHistory([
      run({ runId: "ok", status: "succeeded" }),
      run({ runId: "bad", status: "failed" }),
      run({ runId: "gone", status: "aborted" }),
    ]);
    expect(kept.map((entry) => entry.runId)).toEqual(["ok", "bad", "gone"]);
  });

  it("EXCLUDES a blocked run, because a park is a wait and not an outcome", () => {
    const kept = selectPlanHistory([
      run({ runId: "parked", status: "blocked" }),
      run({ runId: "done", status: "succeeded" }),
    ]);
    expect(kept.map((entry) => entry.runId)).toEqual(["done"]);
  });

  it("excludes a run that never ran", () => {
    const kept = selectPlanHistory([
      run({ runId: "waiting", status: "queued" }),
      run({ runId: "working", status: "running" }),
    ]);
    expect(kept).toEqual([]);
  });

  it("drops a row whose counters are unusable rather than poisoning the factor", () => {
    const kept = selectPlanHistory([
      run({ runId: "nan", iterationCount: Number.NaN }),
      run({ runId: "inf", fixCycleCount: Number.POSITIVE_INFINITY }),
      run({ runId: "negative", iterationCount: -1 }),
      run({ runId: "fine" }),
    ]);
    expect(kept.map((entry) => entry.runId)).toEqual(["fine"]);
  });

  it("caps at the window and keeps the NEWEST, since a look back weighs recent work", () => {
    const runs = Array.from({ length: 25 }, (_, i) => run({ runId: `run-${i}` }));
    const kept = selectPlanHistory(runs, 3);
    expect(kept.map((entry) => entry.runId)).toEqual(["run-0", "run-1", "run-2"]);
  });

  it("keeps every run when there are fewer than the window", () => {
    const runs = [run({ runId: "a" }), run({ runId: "b" })];
    expect(selectPlanHistory(runs, 20)).toHaveLength(2);
  });

  it("is an empty window with nothing to look back on — the cold start", () => {
    expect(selectPlanHistory([])).toEqual([]);
  });

  it("defaults to the declared window and a window of one", () => {
    expect(PLAN_HISTORY_WINDOW).toBe(20);
    expect(FINISHED_RUN_STATUSES).toEqual(["succeeded", "failed", "aborted"]);
    const many = Array.from({ length: 25 }, (_, i) => run({ runId: `r${i}` }));
    expect(selectPlanHistory(many)).toHaveLength(PLAN_HISTORY_WINDOW);
    expect(selectPlanHistory(many, 1)).toHaveLength(1);
  });

  it("is deterministic — the same input yields the same window", () => {
    const runs = [run({ runId: "a" }), run({ runId: "b" })];
    expect(JSON.stringify(selectPlanHistory(runs))).toBe(JSON.stringify(selectPlanHistory(runs)));
  });
});
