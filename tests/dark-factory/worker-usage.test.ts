import { describe, expect, it } from "vitest";
import {
  createWorkerUsageRecorder,
  WorkerUsageRecorder,
} from "../../agent/lib/dark-factory/worker-usage";
import {
  InMemoryUsageStore,
  type UsageAggregate,
  type UsageQuery,
  type UsageReadResult,
  type UsageStore,
  type UsageWriteResult,
} from "../../agent/lib/dark-factory/usage-store";
import type { UsageEvent } from "../../agent/lib/dark-factory/usage-ledger";

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

const context = { runId: "run-9", model: "deepseek/deepseek-chat", pbiId: 209 };

describe("WorkerUsageRecorder", () => {
  it("records a task-completion event with the worker task type", async () => {
    const store = new InMemoryUsageStore();
    const recorder = new WorkerUsageRecorder(store, context);

    const ok = await recorder.record({ ts: "2026-09-30T10:00:00.000Z" });

    expect(ok).toBe(true);
    expect(store.getEvents()).toEqual([
      {
        runId: "run-9",
        pbiId: 209,
        taskType: "developer",
        model: "deepseek/deepseek-chat",
        ts: "2026-09-30T10:00:00.000Z",
      },
    ]);
  });

  it("carries measured values when the caller has them", async () => {
    const store = new InMemoryUsageStore();
    const recorder = new WorkerUsageRecorder(store, context);

    await recorder.record({
      taskType: "tester",
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.05,
      durationMs: 900,
      ts: "2026-09-30T10:00:00.000Z",
    });

    expect(store.getEvents()[0]).toMatchObject({
      taskType: "tester",
      tokensIn: 10,
      tokensOut: 20,
      costUsd: 0.05,
      durationMs: 900,
    });
  });

  it("omits unmeasured fields rather than zero-filling them", async () => {
    const store = new InMemoryUsageStore();
    const recorder = new WorkerUsageRecorder(store, context);

    await recorder.record({ ts: "2026-09-30T10:00:00.000Z" });

    const [event] = store.getEvents();
    expect(event).not.toHaveProperty("costUsd");
    expect(event).not.toHaveProperty("tokensIn");
    expect(event).not.toHaveProperty("durationMs");
  });

  it("omits pbiId when the context has none", async () => {
    const store = new InMemoryUsageStore();
    const recorder = new WorkerUsageRecorder(store, {
      runId: "run-9",
      model: "m",
    });

    await recorder.record({ ts: "2026-09-30T10:00:00.000Z" });

    expect(store.getEvents()[0]).not.toHaveProperty("pbiId");
  });

  it("never throws when the ledger is unavailable", async () => {
    const recorder = new WorkerUsageRecorder(new FailingStore(), context);
    await expect(recorder.record()).resolves.toBe(false);
  });

  it("never throws on a malformed event, because telemetry must not fail the task", async () => {
    const store = new InMemoryUsageStore();
    const recorder = new WorkerUsageRecorder(store, {
      runId: "  ",
      model: "m",
    });
    await expect(recorder.record()).resolves.toBe(false);
  });
});

describe("createWorkerUsageRecorder", () => {
  it("is inert when recording is not configured", () => {
    expect(createWorkerUsageRecorder({}, context)).toBeNull();
    expect(
      createWorkerUsageRecorder({ DF_USAGE_DRIVER: "memory" }, context),
    ).toBeNull();
  });

  it("returns a recorder once an external driver is configured", () => {
    const recorder = createWorkerUsageRecorder(
      {
        DF_USAGE_DRIVER: "sqlite",
        DF_USAGE_DB_PATH: "/tmp/df-worker-usage-test.sqlite",
      },
      context,
    );
    expect(recorder).not.toBeNull();
  });
});