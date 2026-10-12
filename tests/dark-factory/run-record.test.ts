import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { ConsoleRunHistoryStore } from "../../agent/lib/dark-factory/run-history-provider";
import { beginRunRecord } from "../../agent/lib/dark-factory/run-record";

const at = "2026-10-11T12:00:00.000Z";
const directories: string[] = [];
const stores: SqliteRunHistoryStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "df-run-record-"));
  directories.push(directory);
  // The ledger mints the run id — the whole point of #316 is that the runner adopts it.
  const store = new SqliteRunHistoryStore(
    join(directory, "runs.sqlite"),
    () => "ledger-run-1",
  );
  stores.push(store);
  return store;
}

describe("beginRunRecord (#316)", () => {
  it("adopts the id the LEDGER mints, not the runner's attempt id", async () => {
    const store = createStore();

    const begun = await beginRunRecord({
      history: store,
      attemptId: "run-316-attempt-1",
      repo: "Owner/Repo",
      issue: 316,
      receivedAt: at,
    });

    expect(begun.recorded).toBe(true);
    expect(begun.fellBack).toBe(false);
    expect(begun.runId).toBe("ledger-run-1");
    expect(begun.runId).not.toBe("run-316-attempt-1");

    // The adopted id is one the ledger KNOWS, so the events the runner appends later
    // (terminal lifecycle, breaker trip) attach to a real run instead of being orphans.
    const read = await store.getRun(begun.runId);
    expect(read.ok).toBe(true);
    expect(read.value?.issue).toBe(316);
    expect(read.value?.status).toBe("queued");
  });

  it("is a no-op for a repeated attempt, returning the SAME run id", async () => {
    const store = createStore();
    const input = {
      history: store,
      attemptId: "run-316-attempt-2",
      repo: "Owner/Repo",
      issue: 316,
      receivedAt: at,
    };

    const first = await beginRunRecord(input);
    const replay = await beginRunRecord(input);

    expect(replay.runId).toBe(first.runId);
    expect(replay.fellBack).toBe(false);

    const runs = await store.listRuns({ limit: 10 });
    expect(runs.value?.items).toHaveLength(1);
  });

  it("logs loudly and falls back when the ledger is unconfigured, instead of throwing", async () => {
    const log = vi.fn();

    const begun = await beginRunRecord({
      history: new ConsoleRunHistoryStore(),
      attemptId: "run-316-attempt-3",
      repo: "Owner/Repo",
      issue: 316,
      receivedAt: at,
      log,
    });

    expect(begun.fellBack).toBe(true);
    expect(begun.recorded).toBe(false);
    expect(begun.runId).toBe("run-316-attempt-3");
    expect(log.mock.calls.flat().join(" ")).toMatch(/not be recorded/i);
  });

  it("never throws when the store itself fails", async () => {
    const failing = {
      acceptDelivery: async () => {
        throw new Error("ledger exploded");
      },
    } as never;
    const log = vi.fn();

    const begun = await beginRunRecord({
      history: failing,
      attemptId: "run-316-attempt-4",
      repo: "Owner/Repo",
      issue: 316,
      receivedAt: at,
      log,
    });

    expect(begun.fellBack).toBe(true);
    expect(begun.runId).toBe("run-316-attempt-4");
    expect(log.mock.calls.flat().join(" ")).toMatch(/ledger exploded/i);
  });
});
