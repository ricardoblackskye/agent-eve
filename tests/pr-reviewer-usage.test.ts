import { describe, expect, it } from "vitest";
import {
  createReviewUsageStore,
  extractOpenRouterUsage,
  recordReviewUsage,
} from "../scripts/pr-reviewer-usage";
import {
  InMemoryUsageStore,
  type UsageAggregate,
  type UsageQuery,
  type UsageReadResult,
  type UsageStore,
  type UsageWriteResult,
} from "../agent/lib/dark-factory/usage-store";
import type { UsageEvent } from "../agent/lib/dark-factory/usage-ledger";

const MODEL = "deepseek/deepseek-chat";

/** A ledger that always fails — the outage fixture, no mocks. */
class FailingStore implements UsageStore {
  id = "failing";

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
      error: "down",
    };
  }

  close(): void {}
}

describe("extractOpenRouterUsage", () => {
  it("reads prompt/completion tokens and cost from the usage block", () => {
    expect(
      extractOpenRouterUsage({
        usage: { prompt_tokens: 1200, completion_tokens: 300, cost: 0.42 },
      }),
    ).toEqual({ tokensIn: 1200, tokensOut: 300, costUsd: 0.42 });
  });

  it("accepts total_cost as the cost field", () => {
    expect(extractOpenRouterUsage({ usage: { total_cost: 0.5 } })).toEqual({
      costUsd: 0.5,
    });
  });

  it("returns nothing when the provider reported no usage", () => {
    expect(extractOpenRouterUsage({ choices: [] })).toEqual({});
    expect(extractOpenRouterUsage(null)).toEqual({});
    expect(extractOpenRouterUsage(undefined)).toEqual({});
  });

  it("omits a non-numeric or negative measurement rather than zero-filling", () => {
    expect(
      extractOpenRouterUsage({
        usage: { prompt_tokens: "lots", completion_tokens: -1, cost: Number.NaN },
      }),
    ).toEqual({});
  });

  it("keeps a measured zero", () => {
    expect(extractOpenRouterUsage({ usage: { cost: 0 } })).toEqual({ costUsd: 0 });
  });
});

describe("createReviewUsageStore", () => {
  it("is inert when recording is not configured", () => {
    expect(createReviewUsageStore({})).toBeNull();
    expect(createReviewUsageStore({ DF_USAGE_DRIVER: "memory" })).toBeNull();
  });

  it("returns a store once an external driver is configured", () => {
    const store = createReviewUsageStore({
      DF_USAGE_DRIVER: "sqlite",
      DF_USAGE_DB_PATH: "/tmp/df-review-usage-test.sqlite",
    });
    expect(store).not.toBeNull();
    expect(store?.id).toBe("buffered");
    void store?.close?.();
  });
});

describe("recordReviewUsage", () => {
  it("does nothing when the store is null", async () => {
    await expect(
      recordReviewUsage(null, { runId: "r", model: MODEL }),
    ).resolves.toBe(false);
  });

  it("records the measured usage", async () => {
    const store = new InMemoryUsageStore();
    const ok = await recordReviewUsage(store, {
      runId: "run-1",
      model: MODEL,
      data: { usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.1 } },
      durationMs: 1234,
      ts: "2026-09-30T10:00:00.000Z",
    });

    expect(ok).toBe(true);
    expect(store.getEvents()).toEqual([
      {
        runId: "run-1",
        taskType: "pr-review",
        model: MODEL,
        tokensIn: 10,
        tokensOut: 20,
        costUsd: 0.1,
        durationMs: 1234,
        ts: "2026-09-30T10:00:00.000Z",
      },
    ]);
  });

  it("omits unmeasured fields rather than zero-filling them", async () => {
    const store = new InMemoryUsageStore();
    await recordReviewUsage(store, {
      runId: "run-1",
      model: MODEL,
      durationMs: 5,
      ts: "2026-09-30T10:00:00.000Z",
    });

    const [event] = store.getEvents();
    expect(event).not.toHaveProperty("costUsd");
    expect(event).not.toHaveProperty("tokensIn");
    expect(event.durationMs).toBe(5);
  });

  it("never throws when the ledger is unavailable", async () => {
    await expect(
      recordReviewUsage(new FailingStore(), { runId: "r", model: MODEL }),
    ).resolves.toBe(false);
  });

  it("never throws on a malformed event, because telemetry must not fail CI", async () => {
    const store = new InMemoryUsageStore();
    await expect(
      recordReviewUsage(store, { runId: "  ", model: MODEL }),
    ).resolves.toBe(false);
  });
});