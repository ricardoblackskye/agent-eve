/**
 * #748 chapter 3 — the list filters belong to the STORE.
 *
 * The list is keyset-paged, so a filter the client applies only ever sees the page it fetched: a match on
 * page two is silently hidden. These cases pin the store-side filter, and the second case is the defect
 * stated as a test — the match is deliberately NOT on the first page.
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
  const directory = mkdtempSync(join(tmpdir(), "df-run-filters-"));
  directories.push(directory);
  const store = new SqliteRunHistoryStore(join(directory, "runs.sqlite"), () => "generated");
  stores.push(store);
  return store;
}

function summary(
  runId: string,
  createdAt: string,
  overrides: Partial<RunSummary> = {},
): RunSummary {
  return {
    runId,
    repo: "owner/alpha",
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
    ...overrides,
  };
}

// Newest first, so the run matching "zzz" is written LAST and is therefore the OLDEST:
// with a small limit it cannot appear on the first page.
const RUNS: RunSummary[] = [
  summary("df-newest", "2026-09-24T12:00:00.000Z"),
  summary("df-middle", "2026-09-24T11:00:00.000Z", { repo: "owner/beta", stage: "review" }),
  summary("df-oldest", "2026-09-24T10:00:00.000Z", { repo: "owner/gamma" }),
  summary("df-zzz", "2026-09-24T09:00:00.000Z", { repo: "owner/webfeedpoc" }),
];

async function seeded(): Promise<SqliteRunHistoryStore> {
  const store = createStore();
  for (const run of RUNS) {
    const written = await store.recordRunSummary(run);
    expect(written.ok).toBe(true);
  }
  return store;
}

describe("#748 the run list filters in the store", () => {
  it("finds a match beyond the first page, which a client-side filter cannot", async () => {
    const store = await seeded();
    const first = await store.listRuns({ limit: 2 });
    expect(first.value?.items.map((row) => row.runId)).not.toContain("df-zzz");

    const found = await store.listRuns({ limit: 2, search: "zzz" });
    expect(found.value?.items.map((row) => row.runId)).toEqual(["df-zzz"]);
  });

  it("searches the run id, the repo and the stage, case-insensitively", async () => {
    const store = await seeded();
    const byRepo = await store.listRuns({ search: "WEBFEEDPOC" });
    expect(byRepo.value?.items.map((row) => row.runId)).toEqual(["df-zzz"]);

    const byId = await store.listRuns({ search: "df-middle" });
    expect(byId.value?.items.map((row) => row.runId)).toEqual(["df-middle"]);

    const byStage = await store.listRuns({ search: "review" });
    expect(byStage.value?.items.map((row) => row.runId)).toEqual(["df-middle"]);
  });

  it("filters on a stage exactly", async () => {
    const store = await seeded();
    const page = await store.listRuns({ stage: "review" });
    expect(page.value?.items.map((row) => row.runId)).toEqual(["df-middle"]);
  });

  it("keeps the filter when it pages, so page two is still filtered", async () => {
    const store = await seeded();
    const first = await store.listRuns({ stage: "terminal", limit: 2 });
    expect(first.value?.items).toHaveLength(2);
    const cursor = first.value?.nextCursor;
    expect(cursor).toBeTruthy();

    const second = await store.listRuns({ stage: "terminal", limit: 2, cursor: cursor ?? undefined });
    expect(second.value?.items.map((row) => row.runId)).toEqual(["df-zzz"]);
  });

  it("refuses a blank term rather than matching everything", async () => {
    const store = await seeded();
    await expect(store.listRuns({ search: "   " })).rejects.toThrow(/search/);
    await expect(store.listRuns({ stage: "  " })).rejects.toThrow(/stage/);
  });
});
