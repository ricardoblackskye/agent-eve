import { describe, expect, it, vi } from "vitest";
import { readPlanHistory } from "../../scripts/dark-factory-runner";
import { FINISHED_RUN_STATUSES, selectPlanHistory } from "../../agent/lib/dark-factory/plan-history";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
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

function storeReturning(items: RunSummary[], ok = true) {
  const listRuns = vi.fn(async () => ({
    ok,
    mode: "live" as const,
    providerId: "stub",
    ...(ok ? { value: { items } } : { error: "history down" }),
  }));
  return { store: { listRuns } as unknown as RunHistoryStore, listRuns };
}

describe("the plan history reader (#533)", () => {
  it("reads the repository's FINISHED runs, newest first, and selects them", async () => {
    const items = [run({ runId: "a" }), run({ runId: "parked", status: "blocked" })];
    const { store, listRuns } = storeReturning(items);

    const history = await readPlanHistory(store, "owner/repo");

    expect(listRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "owner/repo",
        statuses: FINISHED_RUN_STATUSES,
        direction: "desc",
      }),
    );
    expect(history.map((entry) => entry.runId)).toEqual(["a"]);
    expect(history).toEqual(selectPlanHistory(items));
  });

  it("returns an empty window when the read reports a failure, rather than throwing", async () => {
    const { store } = storeReturning([], false);
    await expect(readPlanHistory(store, "owner/repo")).resolves.toEqual([]);
  });

  it("returns an empty window when the store itself throws, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = {
      listRuns: vi.fn(async () => {
        throw new Error("history down");
      }),
    } as unknown as RunHistoryStore;

    await expect(readPlanHistory(store, "owner/repo")).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
