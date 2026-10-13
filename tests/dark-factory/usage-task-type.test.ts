import { describe, expect, it } from "vitest";
import type { UsageEvent } from "../../agent/lib/dark-factory/usage-ledger";
import { summarizeUsage } from "../../agent/lib/dark-factory/usage-store";

/**
 * #277 T2 — the ledger records `taskType` on EVERY event (it is a required field), yet nothing in
 * the report grouped by it. Per-model duration was likewise collected and never exposed. Both are
 * data we already have; this is presentation, not new collection.
 */
function ev(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    runId: "r1",
    taskType: "developer",
    model: "m/model",
    ts: "2026-10-01T10:00:00.000Z",
    ...over,
  };
}

describe("summarizeUsage — task-type breakdown and per-model duration (#277 T2)", () => {
  it("groups usage by task type, sorted, each with its own sums", () => {
    const agg = summarizeUsage([
      ev({ taskType: "developer", costUsd: 0.5, tokensIn: 10, tokensOut: 5 }),
      ev({ taskType: "developer", costUsd: 0.25 }),
      ev({ taskType: "tester", costUsd: 0.1, durationMs: 1200 }),
    ]);

    expect(agg.byTaskType.map((row) => row.taskType)).toEqual([
      "developer",
      "tester",
    ]);

    const developer = agg.byTaskType[0];
    expect(developer.calls).toBe(2);
    expect(developer.costUsd).toBeCloseTo(0.75, 10);
    expect(developer.tokensIn).toBe(10);
    expect(developer.tokensOut).toBe(5);
    expect(agg.byTaskType[1].durationMs).toBe(1200);
  });

  it("keeps an unmeasured sum ABSENT in a task-type bucket, never 0", () => {
    const agg = summarizeUsage([ev({ taskType: "developer" })]);
    const developer = agg.byTaskType[0];

    expect(developer.calls).toBe(1);
    // Absence, not zero — ADR 0003.
    expect("costUsd" in developer).toBe(false);
    expect("durationMs" in developer).toBe(false);
    expect("tokensIn" in developer).toBe(false);
  });

  it("carries duration per model, since it is already collected", () => {
    const agg = summarizeUsage([
      ev({ model: "a/one", durationMs: 800, costUsd: 0.1 }),
      ev({ model: "b/two" }),
    ]);

    expect(agg.byModel[0].durationMs).toBe(800);
    expect("durationMs" in agg.byModel[1]).toBe(false);
  });
});
