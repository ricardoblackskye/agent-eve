/**
 * #424 — choosing the scan store FAILS CLOSED, and so does reading through it.
 *
 * An unconfigured or unknown driver throws rather than falling back to the fixture or to an empty table. An empty
 * table renders as "no repositories are ready" — which looks like a measurement and is not one, so the wrong answer
 * would be indistinguishable from a legitimate zero.
 *
 * The read seam has the same shape in the other direction: a store that FAILS must throw rather than return
 * `undefined`, because a broken database must not look like a repository nobody has scanned yet. Both halves are
 * safety properties that need no database to state, so they are pinned here rather than only through a driver.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PostgresAmmScanStore } from "../../agent/lib/dark-factory/amm-scan-postgres";
import {
  ammProviderFromEnv,
  createAmmScanStore,
  databaseAmmProvider,
  recordAmmScan,
} from "../../agent/lib/dark-factory/amm-scan-provider";
import {
  SqliteAmmScanStore,
  toStoredScan,
  type AmmScanStore,
  type ReadResult,
  type StoredAmmScan,
} from "../../agent/lib/dark-factory/amm-scan-store";
import { scoreRepo } from "../../agent/lib/dark-factory/amm-scoring";

const STAMP = "2026-10-21T00:00:00.000Z";
const directories: string[] = [];
const closable: { close(): void }[] = [];

afterEach(async () => {
  for (const store of closable.splice(0)) await store.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scan(repo = "a/one"): StoredAmmScan {
  return toStoredScan(scoreRepo({ repo, measurements: {}, scannedAt: STAMP }), undefined);
}

describe("#424 createAmmScanStore fails closed", () => {
  it("refuses to run with no driver, and says why", () => {
    expect(() => createAmmScanStore({})).toThrow(/DF_AMM_SCAN_DRIVER is not set/);
  });

  it("refuses an unknown driver rather than guessing one", () => {
    expect(() => createAmmScanStore({ DF_AMM_SCAN_DRIVER: "mysql" })).toThrow(
      /unknown DF_AMM_SCAN_DRIVER: mysql/,
    );
  });

  it("refuses sqlite without a database path", () => {
    expect(() => createAmmScanStore({ DF_AMM_SCAN_DRIVER: "sqlite" })).toThrow(
      /sqlite requires DF_AMM_SCAN_DB_PATH/,
    );
  });

  it("refuses postgres without a connection string", () => {
    expect(() => createAmmScanStore({ DF_AMM_SCAN_DRIVER: "postgres" })).toThrow(
      /postgres requires DF_AMM_SCAN_DATABASE_URL/,
    );
  });

  it("builds the sqlite store once it is configured", () => {
    const directory = mkdtempSync(join(tmpdir(), "df-amm-provider-"));
    directories.push(directory);

    const store = createAmmScanStore({
      DF_AMM_SCAN_DRIVER: "sqlite",
      DF_AMM_SCAN_DB_PATH: join(directory, "scans.sqlite"),
    });

    expect(store).toBeInstanceOf(SqliteAmmScanStore);
    expect(store.id).toBe("sqlite");
    closable.push(store);
  });

  it("builds the postgres store once it is configured", () => {
    const store = createAmmScanStore({
      DF_AMM_SCAN_DRIVER: "postgres",
      DF_AMM_SCAN_DATABASE_URL: "postgres://postgres@localhost:5432/darkfactory",
    });

    expect(store).toBeInstanceOf(PostgresAmmScanStore);
    expect(store.id).toBe("postgres");
    closable.push(store);
  });
});

describe("#424 the read seam keeps 'no scan' and 'broken' apart", () => {
  /** Only `latestScans` is reached by the provider; the rest exists to satisfy the seam. */
  function storeReturning(result: ReadResult<StoredAmmScan[]>): AmmScanStore {
    return {
      id: "stub",
      recordScan: vi.fn(),
      latestScans: vi.fn(async () => result),
      history: vi.fn(),
      close: vi.fn(),
    } as unknown as AmmScanStore;
  }

  it("answers undefined for a repository nobody has scanned", async () => {
    const provider = databaseAmmProvider(storeReturning({ ok: true, value: [] }));

    expect(await provider.scan("a/one")).toBeUndefined();
  });

  it("returns the scan when there is one", async () => {
    const expected = scan();
    const provider = databaseAmmProvider(storeReturning({ ok: true, value: [expected] }));

    expect(await provider.scan("a/one")).toEqual(expected);
  });

  it("THROWS when the read fails, so a broken store is not read as a repo that has never been scanned", async () => {
    const provider = databaseAmmProvider(
      storeReturning({ ok: false, error: "connection refused" }),
    );

    await expect(provider.scan("a/one")).rejects.toThrow(
      /reading the AMM scan for a\/one failed: connection refused/,
    );
  });

  it("still throws when the failure carries no message", async () => {
    const provider = databaseAmmProvider(storeReturning({ ok: false }));

    await expect(provider.scan("a/one")).rejects.toThrow(/unknown error/);
  });
});

describe("#465 the page-facing selector reads the measure, or refuses", () => {
  it("reads back the scan the store holds", async () => {
    const directory = mkdtempSync(join(tmpdir(), "df-amm-select-"));
    directories.push(directory);
    const dbPath = join(directory, "scans.sqlite");

    const recorder = createAmmScanStore({
      DF_AMM_SCAN_DRIVER: "sqlite",
      DF_AMM_SCAN_DB_PATH: dbPath,
    });
    const expected = scan();
    const written = await recorder.recordScan(expected);
    expect(written.ok).toBe(true);
    await recorder.close();

    const provider = ammProviderFromEnv({
      DF_AMM_SCAN_DRIVER: "sqlite",
      DF_AMM_SCAN_DB_PATH: dbPath,
    });
    // It created the store, so it must offer the release: without this the handle outlives the test and
    // Windows refuses to remove the directory.
    closable.push({ close: () => provider.close?.() });
    const found = await provider.scan("a/one");

    expect(typeof provider.close).toBe("function");
    expect(found?.repo).toBe("a/one");
    expect(found?.overall.level).toBe(expected.overall.level);
    expect(found?.pillars).toHaveLength(expected.pillars.length);
  });

  it("REFUSES to build a provider with nothing configured, rather than inventing one", () => {
    expect(() => ammProviderFromEnv({})).toThrow(/DF_AMM_SCAN_DRIVER is not set/);
  });
});

describe("#465 recording a measured scan closes the write link", () => {
  function sqliteEnv(dbPath: string) {
    return { DF_AMM_SCAN_DRIVER: "sqlite", DF_AMM_SCAN_DB_PATH: dbPath };
  }

  /** A later measurement of the same repository: a new `scannedAt`, so it is a new row. */
  function laterScan(): StoredAmmScan {
    return toStoredScan(
      scoreRepo({ repo: "a/one", measurements: {}, scannedAt: "2026-10-22T00:00:00.000Z" }),
      undefined,
    );
  }

  it("writes the scan through the configured store and reports where it went", async () => {
    const directory = mkdtempSync(join(tmpdir(), "df-amm-record-"));
    directories.push(directory);
    const env = sqliteEnv(join(directory, "scans.sqlite"));

    const outcome = await recordAmmScan(laterScan(), env);

    expect(outcome.recorded).toBe(true);
    expect(outcome.configured).toBe(true);
    expect(outcome.storeId).toBe("sqlite");
    expect(outcome.rowId).toBeTruthy();

    const reader = createAmmScanStore(env);
    closable.push(reader);
    const rows = await reader.history("a/one");

    expect(rows.ok).toBe(true);
    expect(rows.value).toHaveLength(1);
  });

  it("says nothing was persisted when no store is configured, without throwing", async () => {
    const outcome = await recordAmmScan(scan(), {});

    expect(outcome.recorded).toBe(false);
    expect(outcome.configured).toBe(false);
    expect(outcome.reason).toMatch(/DF_AMM_SCAN_DRIVER/);
  });

  it("keeps a later measurement as a new row, and does not duplicate an identical one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "df-amm-record-"));
    directories.push(directory);
    const env = sqliteEnv(join(directory, "scans.sqlite"));

    await recordAmmScan(laterScan(), env);
    await recordAmmScan(laterScan(), env);
    await recordAmmScan(scan(), env);

    const reader = createAmmScanStore(env);
    closable.push(reader);
    const rows = await reader.history("a/one");

    expect(rows.ok).toBe(true);
    expect(rows.value).toHaveLength(2);
  });
});