import { describe, expect, it } from "vitest";
import { InMemoryUsageStore } from "../../agent/lib/dark-factory/usage-store";
import { queryUsage } from "../../agent/lib/dark-factory/usage-query";
import type {
  UsageAggregate,
  UsageQuery,
  UsageReadResult,
  UsageStore,
  UsageWriteResult,
} from "../../agent/lib/dark-factory/usage-store";
import type { UsageEvent } from "../../agent/lib/dark-factory/usage-ledger";

function event(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    runId: "run-1",
    taskType: "pr-review",
    model: "deepseek/deepseek-chat",
    ts: "2026-09-30T10:00:00.000Z",
    ...over,
  };
}

/** A ledger that cannot be read — the outage fixture, no mocks. */
class UnavailableStore implements UsageStore {
  id = "unavailable";

  async record(_event: UsageEvent): Promise<UsageWriteResult> {
    return { ok: false, mode: "blocked", providerId: this.id, error: "down" };
  }

  async aggregate(
    _query: UsageQuery = {},
  ): Promise<UsageReadResult<UsageAggregate>> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      value: null,
      error: "ledger unavailable",
    };
  }

  close(): void {}
}

describe("queryUsage", () => {
  it("returns totals and the groupings for a populated ledger", async () => {
    const store = new InMemoryUsageStore();
    await store.record(
      event({ runId: "r1", costUsd: 0.5, tokensIn: 10, tokensOut: 20 }),
    );
    await store.record(
      event({ runId: "r2", model: "other/model", costUsd: 0.25 }),
    );

    const outcome = await queryUsage(store);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.totals).toEqual({
      calls: 2,
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.75,
    });
    expect(outcome.report.byModel.map((row) => row.model)).toEqual([
      "deepseek/deepseek-chat",
      "other/model",
    ]);
    expect(outcome.report.byDay).toEqual([
      { date: "2026-09-30", calls: 2, costUsd: 0.75 },
    ]);
    expect(outcome.report.unmeasured).toBe(0);
  });

  it("preserves absence: an unmeasured sum is omitted, not zero-filled", async () => {
    const store = new InMemoryUsageStore();
    await store.record(event({ runId: "r1" }));

    const outcome = await queryUsage(store);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.totals).not.toHaveProperty("costUsd");
    expect(outcome.report.totals).not.toHaveProperty("tokensIn");
    expect(outcome.report.unmeasured).toBe(1);
  });

  it("echoes the applied window and filters on it", async () => {
    const store = new InMemoryUsageStore();
    await store.record(event({ ts: "2026-09-29T00:00:00.000Z", runId: "before" }));
    await store.record(event({ ts: "2026-09-30T00:00:00.000Z", runId: "inside" }));

    const outcome = await queryUsage(store, {
      from: "2026-09-30T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.from).toBe("2026-09-30T00:00:00.000Z");
    expect(outcome.report.to).toBe("2026-10-01T00:00:00.000Z");
    expect(outcome.report.totals.calls).toBe(1);
  });

  it("filters by model and by run", async () => {
    const store = new InMemoryUsageStore();
    await store.record(event({ runId: "r1", model: "a" }));
    await store.record(event({ runId: "r2", model: "b" }));

    const byModel = await queryUsage(store, { model: "b" });
    expect(byModel.ok && byModel.report.totals.calls).toBe(1);

    const byRun = await queryUsage(store, { runId: "r1" });
    expect(byRun.ok && byRun.report.totals.calls).toBe(1);
  });

  it("rejects a malformed window with 400 rather than treating it as an outage", async () => {
    const store = new InMemoryUsageStore();

    const bad = await queryUsage(store, { from: "yesterday" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.status).toBe(400);
    expect(bad.error).toMatch(/from/i);

    const inverted = await queryUsage(store, {
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-09-01T00:00:00.000Z",
    });
    expect(inverted.ok).toBe(false);
    if (inverted.ok) return;
    expect(inverted.status).toBe(400);
  });

  it("reports an unavailable ledger as 503", async () => {
    const outcome = await queryUsage(new UnavailableStore());

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(503);
    expect(outcome.error).toMatch(/unavailable/i);
  });
});