/**
 * Postgres usage ledger integration tests.
 *
 * GATED: skipped unless `DF_USAGE_TEST_DATABASE_URL` points at a disposable
 * database. These are written but NOT exercised without one — the PR says so
 * rather than claiming they ran.
 */

import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PostgresUsageStore } from "../../agent/lib/dark-factory/usage-store-postgres";
import type { UsageEvent } from "../../agent/lib/dark-factory/usage-ledger";

const connectionString = (process.env.DF_USAGE_TEST_DATABASE_URL ?? "").trim();
const suite = connectionString ? describe : describe.skip;

const openStores: PostgresUsageStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) await store.close();
});

function open(): PostgresUsageStore {
  const store = new PostgresUsageStore(connectionString, () => randomUUID());
  openStores.push(store);
  return store;
}

/** Each test uses a unique runId so a shared test database stays isolated. */
function event(runId: string, over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    runId,
    taskType: "pr-review",
    model: "deepseek/deepseek-chat",
    ts: "2026-09-30T10:00:00.000Z",
    ...over,
  };
}

suite("PostgresUsageStore (integration)", () => {
  it("records an event and reads it back", async () => {
    const runId = `it-${randomUUID()}`;
    const store = open();

    const written = await store.record(
      event(runId, { tokensIn: 11, tokensOut: 22, costUsd: 0.5, durationMs: 100 }),
    );
    expect(written.ok).toBe(true);

    const read = await store.aggregate({ runId });
    expect(read.ok).toBe(true);
    expect(read.value?.totals).toEqual({
      calls: 1,
      tokensIn: 11,
      tokensOut: 22,
      costUsd: 0.5,
      durationMs: 100,
    });
  });

  it("keeps an unmeasured field absent rather than zero-filled", async () => {
    const runId = `it-${randomUUID()}`;
    const store = open();
    await store.record(event(runId));

    const read = await store.aggregate({ runId });
    expect(read.value?.totals.calls).toBe(1);
    expect(read.value?.totals).not.toHaveProperty("costUsd");
    expect(read.value?.totals).not.toHaveProperty("tokensIn");
    expect(read.value?.unmeasured).toBe(1);
  });

  it("appends rather than replacing, and windows on ts", async () => {
    const runId = `it-${randomUUID()}`;
    const store = open();
    await store.record(event(runId, { ts: "2026-09-29T00:00:00.000Z" }));
    await store.record(event(runId, { ts: "2026-09-30T00:00:00.000Z" }));

    expect((await store.aggregate({ runId })).value?.totals.calls).toBe(2);

    const windowed = await store.aggregate({
      runId,
      from: "2026-09-30T00:00:00.000Z",
    });
    expect(windowed.value?.totals.calls).toBe(1);
  });
});