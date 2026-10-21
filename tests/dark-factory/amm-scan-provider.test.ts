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
  createAmmScanStore,
  databaseAmmProvider,
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

  it("THROWS when the read fails, so a broken store is not read as an unscanned repo", async () => {
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