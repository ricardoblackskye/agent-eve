/**
 * #421 (R2 follow-up) — the cursor must carry the ordering it was issued under, and ordering must reach
 * columns other than createdAt.
 *
 * Today `RunCursor` is `{ createdAt, runId }`, so the store has no way to tell whether a cursor belongs to
 * the request that presented it: a cursor issued under `status asc` and replayed under `desc` is honoured
 * and returns page 2 of a different list. And because the predicate compares `created_at`, ordering by any
 * other column is refused outright rather than implemented.
 *
 * The walk test is the one that matters most: a keyset walk over a NON-UNIQUE key must visit every row
 * exactly once, and it looks correct in the common case even when it is not.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidRunRecordError,
  type RunStatus,
  type RunSummary,
} from "../../agent/lib/dark-factory/run-history";
import {
  SqliteRunHistoryStore,
  type RunCursor,
} from "../../agent/lib/dark-factory/run-history-store";

const directories: string[] = [];
const stores: SqliteRunHistoryStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): SqliteRunHistoryStore {
  const directory = mkdtempSync(join(tmpdir(), "df-run-cursor-"));
  directories.push(directory);
  const store = new SqliteRunHistoryStore(join(directory, "runs.sqlite"), () => "generated");
  stores.push(store);
  return store;
}

function summary(
  runId: string,
  createdAt: string,
  status: RunStatus,
  repo: string,
): RunSummary {
  // A non-terminal run must NOT carry completedAt - the store refuses it, correctly, so the fixture has to be a
  // record the store would actually accept rather than one that merely type-checks.
  const terminal = status !== "running";
  return {
    runId,
    repo,
    issue: 198,
    status,
    stage: terminal ? "terminal" : "worker",
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    ...(terminal ? { completedAt: createdAt } : {}),
    attemptCount: 1,
    reviewCount: 0,
    iterationCount: 1,
    fixCycleCount: 0,
  };
}

/**
 * Statuses REPEAT on purpose: ordering by a non-unique column is only correct if the run_id tiebreak makes
 * the ordering total, and a walk over a non-unique key is where a keyset implementation loses rows.
 */
const RUNS: RunSummary[] = [
  summary("run-a", "2026-09-24T10:00:00.000Z", "succeeded", "owner/alpha"),
  summary("run-b", "2026-09-24T11:00:00.000Z", "failed", "owner/beta"),
  summary("run-c", "2026-09-24T12:00:00.000Z", "succeeded", "owner/alpha"),
  summary("run-d", "2026-09-24T13:00:00.000Z", "running", "owner/gamma"),
  summary("run-e", "2026-09-24T14:00:00.000Z", "failed", "owner/beta"),
  summary("run-f", "2026-09-24T15:00:00.000Z", "succeeded", "owner/alpha"),
];

async function seed(store: SqliteRunHistoryStore): Promise<void> {
  for (const run of RUNS) {
    const written = await store.recordRunSummary(run);
    expect(written.ok, written.error).toBe(true);
  }
}

describe("#421 the cursor names the ordering it was issued under", () => {
  it("refuses a cursor replayed under the other direction", async () => {
    const store = createStore();
    await seed(store);

    const first = await store.listRuns({ limit: 2, sort: "status", direction: "asc" });
    expect(first.ok, first.error).toBe(true);
    const cursor = first.value?.nextCursor;
    expect(cursor, "expected a next cursor to replay").toBeTruthy();

    await expect(
      store.listRuns({ limit: 2, sort: "status", direction: "desc", cursor }),
    ).rejects.toThrow(InvalidRunRecordError);
  });

  it("refuses a cursor replayed under a different sort", async () => {
    const store = createStore();
    await seed(store);

    const first = await store.listRuns({ limit: 2, sort: "status", direction: "asc" });
    const cursor = first.value?.nextCursor;
    expect(cursor).toBeTruthy();

    await expect(
      store.listRuns({ limit: 2, sort: "repo", direction: "asc", cursor }),
    ).rejects.toThrow(InvalidRunRecordError);
  });

  it("refuses a cursor that names a sort which is not a sort field at all", async () => {
    const store = createStore();
    await seed(store);

    const forged = {
      sort: "nonsense",
      direction: "asc",
      key: "succeeded",
      runId: "run-a",
    } as unknown as RunCursor;

    await expect(store.listRuns({ limit: 2, cursor: forged })).rejects.toThrow(
      InvalidRunRecordError,
    );
  });
});

describe("#421 ordering by a column other than createdAt", () => {
  it("orders by status ascending, from the store", async () => {
    const store = createStore();
    await seed(store);

    const page = await store.listRuns({ limit: 10, sort: "status", direction: "asc" });
    expect(page.ok, page.error).toBe(true);
    const statuses = (page.value?.items ?? []).map((item) => item.status);
    expect(statuses).toEqual([...statuses].sort());
  });

  it("orders by repo, and returns the same set of runs whichever way it is ordered", async () => {
    const store = createStore();
    await seed(store);

    const byRepo = await store.listRuns({ limit: 10, sort: "repo", direction: "asc" });
    expect(byRepo.ok, byRepo.error).toBe(true);
    const repos = (byRepo.value?.items ?? []).map((item) => item.repo);
    expect(repos).toEqual([...repos].sort());

    const byTime = await store.listRuns({ limit: 10 });
    expect([...(byRepo.value?.items ?? [])].map((i) => i.runId).sort()).toEqual(
      [...(byTime.value?.items ?? [])].map((i) => i.runId).sort(),
    );
  });

  it("walks EVERY row exactly once when paging over a non-unique key", async () => {
    const store = createStore();
    await seed(store);

    const walked: string[] = [];
    let cursor: RunCursor | undefined;

    for (let guard = 0; guard < 20; guard += 1) {
      const page: Awaited<ReturnType<SqliteRunHistoryStore["listRuns"]>> =
        await store.listRuns({ limit: 2, sort: "status", direction: "asc", cursor });
      expect(page.ok, page.error).toBe(true);
      for (const item of page.value?.items ?? []) walked.push(item.runId);
      cursor = page.value?.nextCursor;
      if (!cursor) break;
    }

    expect(cursor, "the walk should have exhausted the list").toBeUndefined();
    expect(walked.length, "every row is visited once - no repeats, no losses").toBe(RUNS.length);
    expect(new Set(walked).size).toBe(RUNS.length);
    expect([...walked].sort()).toEqual(RUNS.map((run) => run.runId).sort());
  });
});

describe("#421 the refusals R2 relied on survive", () => {
  it("refuses a sort that is not a sort field", async () => {
    const store = createStore();
    await seed(store);

    await expect(
      store.listRuns({ sort: "nonsense" as unknown as "createdAt" }),
    ).rejects.toThrow(InvalidRunRecordError);
  });

  it("refuses a direction that is neither asc nor desc", async () => {
    const store = createStore();
    await seed(store);

    await expect(
      store.listRuns({ direction: "sideways" as unknown as "asc" }),
    ).rejects.toThrow(InvalidRunRecordError);
  });

  it("refuses a cursor whose key is not a timestamp for the createdAt sort", async () => {
    const store = createStore();
    await seed(store);

    const forged = {
      sort: "createdAt",
      direction: "desc",
      key: "not-a-timestamp",
      runId: "run-a",
    } as unknown as RunCursor;

    await expect(store.listRuns({ cursor: forged })).rejects.toThrow(InvalidRunRecordError);
  });

  it("still pages newest-first by default", async () => {
    const store = createStore();
    await seed(store);

    const page = await store.listRuns({ limit: 10 });
    expect(page.ok, page.error).toBe(true);
    const times = (page.value?.items ?? []).map((item) => item.createdAt);
    expect(times).toEqual([...times].sort().reverse());
  });
});
