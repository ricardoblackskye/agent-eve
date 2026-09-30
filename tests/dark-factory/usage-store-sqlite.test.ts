import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteUsageStore } from "../../agent/lib/dark-factory/usage-store-sqlite";
import {
  InvalidUsageEventError,
  type UsageEvent,
} from "../../agent/lib/dark-factory/usage-ledger";

const tempDirs: string[] = [];
const openStores: SqliteUsageStore[] = [];

function tempPath(): string {
  const dir = join(tmpdir(), `df-usage-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return join(dir, "usage.sqlite");
}

function open(path: string): SqliteUsageStore {
  const store = new SqliteUsageStore(path, () => randomUUID());
  openStores.push(store);
  return store;
}

afterEach(() => {
  // An open node:sqlite handle locks its file on Windows: close before deleting.
  for (const store of openStores.splice(0)) store.close();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function event(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    runId: "run-1",
    taskType: "pr-review",
    model: "deepseek/deepseek-chat",
    ts: "2026-09-30T10:00:00.000Z",
    ...over,
  };
}

describe("SqliteUsageStore", () => {
  it("records an event and reads it back in the aggregate", async () => {
    const store = open(tempPath());

    const written = await store.record(
      event({ tokensIn: 1200, tokensOut: 300, costUsd: 0.42, durationMs: 8400 }),
    );
    expect(written.ok).toBe(true);
    expect(written.mode).toBe("live");

    const read = await store.aggregate();
    expect(read.ok).toBe(true);
    expect(read.value?.totals).toEqual({
      calls: 1,
      tokensIn: 1200,
      tokensOut: 300,
      costUsd: 0.42,
      durationMs: 8400,
    });
  });

  it("leaves an unmeasured field absent rather than zero-filled", async () => {
    const store = open(tempPath());
    await store.record(event({ costUsd: 0 }));

    const read = await store.aggregate();
    expect(read.value?.totals.costUsd).toBe(0);
    expect(read.value?.totals).not.toHaveProperty("tokensIn");
    expect(read.value?.totals).not.toHaveProperty("durationMs");
  });

  it("persists events across a reopen (append-only)", async () => {
    const path = tempPath();
    const first = open(path);
    await first.record(event({ runId: "a" }));
    first.close();

    const second = open(path);
    await second.record(event({ runId: "b" }));

    const read = await second.aggregate();
    expect(read.value?.totals.calls).toBe(2);
    expect(read.value?.byRun.map((row) => row.runId)).toEqual(["a", "b"]);
  });

  it("windows on ts with an inclusive from and an exclusive to", async () => {
    const path = tempPath();
    const store = open(path);
    await store.record(event({ ts: "2026-09-29T23:59:59.000Z", runId: "before" }));
    await store.record(event({ ts: "2026-09-30T00:00:00.000Z", runId: "at-from" }));
    await store.record(event({ ts: "2026-09-30T12:00:00.000Z", runId: "inside" }));
    await store.record(event({ ts: "2026-10-01T00:00:00.000Z", runId: "at-to" }));

    const read = await store.aggregate({
      from: "2026-09-30T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });

    expect(read.value?.totals.calls).toBe(2);
    expect(read.value?.byRun.map((row) => row.runId).sort()).toEqual([
      "at-from",
      "inside",
    ]);
  });

  it("throws on an invalid event: a caller bug, not an outage", async () => {
    const store = open(tempPath());
    await expect(store.record(event({ runId: "" }))).rejects.toThrow(
      InvalidUsageEventError,
    );
  });

  it("reports an outage instead of throwing when the database cannot be opened", async () => {
    // A path whose parent directory does not exist: node:sqlite cannot open it.
    const absent = join(tmpdir(), `absent-${randomUUID()}`, "nested", "usage.sqlite");
    const store = new SqliteUsageStore(absent, () => randomUUID());

    const written = await store.record(event());
    expect(written.ok).toBe(false);
    expect(written.mode).toBe("blocked");
    expect(written.error).toMatch(/unavailable/i);

    const read = await store.aggregate();
    expect(read.ok).toBe(false);
    expect(read.value).toBeNull();
    expect(read.error).toMatch(/unavailable/i);
  });

  it("releases the file handle on close so the directory can be removed", async () => {
    const path = tempPath();
    const store = new SqliteUsageStore(path, () => randomUUID());
    await store.record(event());
    store.close();
    store.close(); // idempotent

    const dir = dirname(path);
    expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow();
    const index = tempDirs.indexOf(dir);
    if (index >= 0) tempDirs.splice(index, 1);
  });
});