import { describe, expect, it } from "vitest";
import {
  BufferedUsageRecorder,
  InMemoryUsageStore,
  recordSafely,
  type UsageAggregate,
  type UsageQuery,
  type UsageReadResult,
  type UsageStore,
  type UsageWriteResult,
} from "../../agent/lib/dark-factory/usage-store";
import {
  InvalidUsageEventError,
  type UsageEvent,
} from "../../agent/lib/dark-factory/usage-ledger";

function event(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    runId: "run-1",
    taskType: "pr-review",
    model: "deepseek/deepseek-chat",
    ts: "2026-09-30T10:00:00.000Z",
    ...over,
  };
}

/** A backend that always fails its write — the outage fixture, no mocks. */
class FailingStore implements UsageStore {
  id = "failing";

  async record(_event: UsageEvent): Promise<UsageWriteResult> {
    return {
      ok: false,
      mode: "blocked",
      providerId: this.id,
      error: "ledger unavailable",
    };
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

/** A backend that REJECTS rather than returning a result object. */
class RejectingStore implements UsageStore {
  id = "rejecting";

  async record(_event: UsageEvent): Promise<UsageWriteResult> {
    throw new Error("connection reset");
  }

  async aggregate(
    _query: UsageQuery = {},
  ): Promise<UsageReadResult<UsageAggregate>> {
    throw new Error("connection reset");
  }

  close(): void {}
}

describe("InMemoryUsageStore", () => {
  it("stores a valid event and reports it live", async () => {
    const store = new InMemoryUsageStore();
    const result = await store.record(event({ costUsd: 0.25 }));

    expect(result.ok).toBe(true);
    expect(result.mode).toBe("live");
    expect(result.providerId).toBe("memory");
    expect(result.event?.costUsd).toBe(0.25);
    expect(store.getEvents()).toHaveLength(1);
  });

  it("throws on an invalid event: a caller bug, not an outage", async () => {
    const store = new InMemoryUsageStore();
    await expect(store.record(event({ runId: "  " }))).rejects.toThrow(
      InvalidUsageEventError,
    );
  });

  it("aggregates an empty ledger without inventing measurements", async () => {
    const store = new InMemoryUsageStore();
    const read = await store.aggregate();

    expect(read.ok).toBe(true);
    expect(read.value?.totals.calls).toBe(0);
    expect(read.value?.totals).not.toHaveProperty("costUsd");
    expect(read.value?.unmeasured).toBe(0);
  });
});

describe("BufferedUsageRecorder", () => {
  it("retains the event and reports not-ok when the backend refuses the write", async () => {
    const recorder = new BufferedUsageRecorder(new FailingStore());
    const result = await recorder.record(event());

    expect(result.ok).toBe(false);
    expect(recorder.pending()).toHaveLength(1);
  });

  it("retains the event when the backend REJECTS instead of returning a result", async () => {
    const recorder = new BufferedUsageRecorder(new RejectingStore());
    const result = await recorder.record(event());

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection reset|buffered/i);
    expect(recorder.pending()).toHaveLength(1);
  });

  it("still throws on an invalid event, because that is a caller bug", async () => {
    const recorder = new BufferedUsageRecorder(new InMemoryUsageStore());
    await expect(recorder.record(event({ model: "" }))).rejects.toThrow(
      InvalidUsageEventError,
    );
    expect(recorder.pending()).toHaveLength(0);
  });

  it("drains the buffer once the backend recovers", async () => {
    let healthy = false;
    const backend: UsageStore = {
      id: "flaky",
      async record(e) {
        if (!healthy) {
          return { ok: false, mode: "blocked", providerId: "flaky", error: "down" };
        }
        return { ok: true, mode: "live", providerId: "flaky", event: e };
      },
      async aggregate() {
        return { ok: true, mode: "live", providerId: "flaky", value: null };
      },
      close() {},
    };

    const recorder = new BufferedUsageRecorder(backend);
    await recorder.record(event());
    expect(recorder.pending()).toHaveLength(1);

    healthy = true;
    const flushed = await recorder.flush();

    expect(flushed.ok).toBe(true);
    expect(recorder.pending()).toHaveLength(0);
  });

  it("keeps every event and reports not-ok while the backend is still down", async () => {
    const recorder = new BufferedUsageRecorder(new FailingStore());
    await recorder.record(event({ runId: "a" }));
    await recorder.record(event({ runId: "b" }));

    const flushed = await recorder.flush();

    expect(flushed.ok).toBe(false);
    expect(flushed.error).toMatch(/still unsaved/i);
    expect(recorder.pending()).toHaveLength(2);
  });

  it("re-sends every measured field on retry (no silent field loss)", async () => {
    const captured: UsageEvent[] = [];
    let healthy = false;
    const backend: UsageStore = {
      id: "capture",
      async record(e) {
        if (!healthy) {
          return { ok: false, mode: "blocked", providerId: "capture", error: "down" };
        }
        captured.push(e);
        return { ok: true, mode: "live", providerId: "capture", event: e };
      },
      async aggregate() {
        return { ok: true, mode: "live", providerId: "capture", value: null };
      },
      close() {},
    };

    const recorder = new BufferedUsageRecorder(backend);
    await recorder.record(
      event({
        pbiId: 209,
        tokensIn: 1200,
        tokensOut: 300,
        costUsd: 0.42,
        durationMs: 8400,
      }),
    );

    healthy = true;
    await recorder.flush();

    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      runId: "run-1",
      pbiId: 209,
      taskType: "pr-review",
      model: "deepseek/deepseek-chat",
      tokensIn: 1200,
      tokensOut: 300,
      costUsd: 0.42,
      durationMs: 8400,
      ts: "2026-09-30T10:00:00.000Z",
    });
  });
});

describe("recordSafely", () => {
  it("never throws when the ledger is unavailable", async () => {
    const result = await recordSafely(new FailingStore(), event());
    expect(result.ok).toBe(false);
  });

  it("never throws when the ledger REJECTS", async () => {
    const result = await recordSafely(new RejectingStore(), event());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/connection reset/i);
  });

  it("reports ok for a healthy store", async () => {
    const result = await recordSafely(new InMemoryUsageStore(), event());
    expect(result.ok).toBe(true);
  });

  it("still surfaces a caller bug rather than hiding it", async () => {
    await expect(
      recordSafely(new InMemoryUsageStore(), event({ taskType: "" })),
    ).rejects.toThrow(InvalidUsageEventError);
  });
});