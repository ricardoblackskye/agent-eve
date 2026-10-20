/**
 * #414 (epic #403 R2) — the run list must be ORDERABLE, and the order must SURVIVE paging.
 *
 * The list is keyset-paged: `RunCursor` is `{ createdAt, runId }` and the WHERE is
 * `(created_at < ? OR (created_at = ? AND run_id < ?))`. That cursor is bound to the descending ordering, so this
 * suite pins the two things a sort change can quietly break: the default stays newest-first, and paging under the
 * oldest-first order neither repeats a run nor skips one.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type RunSummary } from "../../agent/lib/dark-factory/run-history";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const directories: string[] = [];
const stores: SqliteRunHistoryStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): SqliteRunHistoryStore {
  const directory = mkdtempSync(join(tmpdir(), "df-run-order-"));
  directories.push(directory);
  const store = new SqliteRunHistoryStore(join(directory, "runs.sqlite"), () => "generated");
  stores.push(store);
  return store;
}

function summary(runId: string, createdAt: string): RunSummary {
  return {
    runId,
    repo: "owner/repo",
    issue: 198,
    status: "succeeded",
    stage: "terminal",
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
    attemptCount: 1,
    reviewCount: 0,
    iterationCount: 1,
    fixCycleCount: 0,
  };
}

const RUNS: RunSummary[] = [
  summary("run-a", "2026-09-24T10:00:00.000Z"),
  summary("run-b", "2026-09-24T11:00:00.000Z"),
  summary("run-c", "2026-09-24T12:00:00.000Z"),
];

async function seededStore(): Promise<SqliteRunHistoryStore> {
  const store = createStore();
  for (const run of RUNS) {
    const written = await store.recordRunSummary(run);
    expect(written.ok).toBe(true);
  }
  return store;
}

describe("#414 the run list is orderable", () => {
  it("defaults to newest first, so adding a sort option cannot change today's behaviour", async () => {
    const store = await seededStore();
    const page = await store.listRuns({});
    expect(page.value?.items.map((row) => row.runId)).toEqual(["run-c", "run-b", "run-a"]);
  });

  it("returns oldest first when asked for ascending createdAt", async () => {
    const store = await seededStore();
    const page = await store.listRuns({ sort: "createdAt", direction: "asc" });
    expect(page.value?.items.map((row) => row.runId)).toEqual(["run-a", "run-b", "run-c"]);
  });

  it("pages through the ascending order without repeating or losing a run", async () => {
    const store = await seededStore();

    const first = await store.listRuns({ sort: "createdAt", direction: "asc", limit: 2 });
    expect(first.value?.items.map((row) => row.runId)).toEqual(["run-a", "run-b"]);

    const cursor = first.value?.nextCursor;
    expect(cursor, "the first page must offer a cursor to continue").toBeTruthy();

    const second = await store.listRuns({
      sort: "createdAt",
      direction: "asc",
      limit: 2,
      cursor,
    });
    expect(second.value?.items.map((row) => row.runId)).toEqual(["run-c"]);
    expect(second.value?.nextCursor).toBeUndefined();
  });

  it("REFUSES an unknown sort field rather than silently ignoring it", async () => {
    // An ignored sort shows unsorted data, which an operator reads as a data bug rather than a bad parameter. The API
    // layer rejects it too; the store refuses as well so a new caller cannot bypass the rule by skipping the route.
    const store = await seededStore();
    const page = await store.listRuns({ sort: "costUsd" as never });
    expect(page.ok).toBe(false);
  });
});
