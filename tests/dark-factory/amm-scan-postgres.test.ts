/**
 * #424 — the POSTGRES driver for AMM scans (integration).
 *
 * The SQLite driver is covered next door; this one was shipped without a test, which is what dropped the coverage
 * gate. The two drivers share a contract but not an implementation — the triad guard, the `ON CONFLICT` write and
 * the "newest per repository" window query are all SQL that only runs here — so the shared tests next door do not
 * exercise a line of this file.
 *
 * GATED: skipped unless the DSN is set. The suite owns its OWN SCHEMA (#392) so it cannot collide with the run-history
 * suites, and it deliberately reuses the run-history DSN: the CI unit job sets five DSNs and this is one of them, so
 * a suite that wants its own namespace takes a schema rather than asking for a sixth variable. Reusing a DSN while
 * owning a schema is the same arrangement active-run-claim.test.ts already uses.
 */
import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresAmmScanStore } from "../../agent/lib/dark-factory/amm-scan-postgres";
import {
  toStoredScan,
  type AmmScanStore,
  type StoredAmmScan,
} from "../../agent/lib/dark-factory/amm-scan-store";
import { scoreRepo, type AmmMeasurements } from "../../agent/lib/dark-factory/amm-scoring";
import { resetPgTables, testDsnFor } from "./pg-test-helpers";

const baseDsn = (process.env.DF_RUN_HISTORY_TEST_DATABASE_URL ?? "").trim();
const connectionString = baseDsn ? testDsnFor(baseDsn, "amm_scan_postgres") : "";
const suite = connectionString ? describe : describe.skip;

const TABLE = "df_amm_scans";
const stores: AmmScanStore[] = [];

function open(): PostgresAmmScanStore {
  const store = new PostgresAmmScanStore({ connectionString });
  stores.push(store);
  return store;
}

/** A scored scan stamped as the provider would store it. */
function scanAt(
  repo: string,
  scannedAt: string,
  tenantId: string | undefined,
  measurements: AmmMeasurements = {},
): StoredAmmScan {
  return toStoredScan(scoreRepo({ repo, measurements, scannedAt }), tenantId);
}

function statesOf(scan: StoredAmmScan): Map<string, string | undefined> {
  return new Map(
    scan.pillars.flatMap((pillar) => pillar.signals ?? []).map((signal) => [signal.id, signal.state]),
  );
}

suite("#424 the Postgres driver stores the triad without collapsing it", () => {
  beforeEach(async () => {
    // Its own schema, so this cannot race another suite's in-flight test (#332).
    if (connectionString) await resetPgTables(testDsnFor(connectionString, "amm_scan_postgres"), [TABLE]);
  });

  afterAll(async () => {
    for (const store of stores.splice(0)) await store.close();
  });

  it("round-trips present, absent AND unmeasured through jsonb without collapsing any of them", async () => {
    const repo = `amm/${randomUUID()}`;
    const store = open();

    const written = await store.recordScan(
      scanAt(repo, "2026-10-21T00:00:00.000Z", "tenant-1", {
        linter: "present",
        formatter: "absent",
        "type-checker": "unmeasured",
      }),
    );
    expect(written.ok).toBe(true);

    const read = await store.latestScans({ repo });
    expect(read.ok).toBe(true);
    expect(read.value).toHaveLength(1);

    const states = statesOf(read.value?.[0] as StoredAmmScan);
    expect(states.get("linter")).toBe("present");
    expect(states.get("formatter")).toBe("absent");
    expect(states.get("type-checker")).toBe("unmeasured");
    // The regression this exists to catch: unmeasured coming back as absent.
    expect(states.get("type-checker")).not.toBe("absent");
  });

  it("keeps the scan's own figures, so a score can be explained later", async () => {
    const repo = `amm/${randomUUID()}`;
    const store = open();
    const scan = scanAt(repo, "2026-10-21T00:00:00.000Z", undefined, { linter: "present" });

    await store.recordScan(scan);
    const read = await store.latestScans({ repo });

    expect(read.value?.[0]?.overall).toEqual(scan.overall);
    expect(read.value?.[0]?.catalogueVersion).toBe(scan.catalogueVersion);
  });

  it("returns only the NEWEST scan per repository — the series is history, not the list", async () => {
    const repo = `amm/${randomUUID()}`;
    const store = open();

    await store.recordScan(scanAt(repo, "2026-10-19T00:00:00.000Z", undefined, { linter: "absent" }));
    await store.recordScan(scanAt(repo, "2026-10-21T00:00:00.000Z", undefined, { linter: "present" }));

    const read = await store.latestScans({ repo });

    expect(read.value).toHaveLength(1);
    expect(read.value?.[0]?.scannedAt).toBe("2026-10-21T00:00:00.000Z");
    expect(statesOf(read.value?.[0] as StoredAmmScan).get("linter")).toBe("present");
  });

  it("does not leak one tenant's scans into another's read", async () => {
    const repo = `amm/${randomUUID()}`;
    const store = open();

    await store.recordScan(scanAt(repo, "2026-10-21T00:00:00.000Z", "tenant-a", { linter: "present" }));
    await store.recordScan(scanAt(repo, "2026-10-20T00:00:00.000Z", "tenant-b", { linter: "absent" }));

    const forA = await store.latestScans({ repo, tenantId: "tenant-a" });

    expect(forA.value).toHaveLength(1);
    expect(forA.value?.[0]?.tenantId).toBe("tenant-a");
    // A readiness figure computed across two tenants is wrong for both.
    expect(statesOf(forA.value?.[0] as StoredAmmScan).get("linter")).toBe("present");
  });

  it("filters by repository when asked", async () => {
    const wanted = `amm/${randomUUID()}`;
    const other = `amm/${randomUUID()}`;
    const store = open();

    await store.recordScan(scanAt(wanted, "2026-10-21T00:00:00.000Z", undefined));
    await store.recordScan(scanAt(other, "2026-10-21T00:00:00.000Z", undefined));

    const read = await store.latestScans({ repo: wanted });

    expect(read.value).toHaveLength(1);
    expect(read.value?.[0]?.repo).toBe(wanted);
  });

  it("honours a limit rather than returning everything", async () => {
    const stamp = "2026-10-21T00:00:00.000Z";
    const repos = Array.from({ length: 4 }, () => `amm/${randomUUID()}`);
    const store = open();
    for (const repo of repos) await store.recordScan(scanAt(repo, stamp, undefined));

    const read = await store.latestScans({ limit: 2 });

    expect(read.value).toHaveLength(2);
  });

  it("keeps the full series in history, newest first", async () => {
    const repo = `amm/${randomUUID()}`;
    const store = open();

    await store.recordScan(scanAt(repo, "2026-10-19T00:00:00.000Z", undefined, { linter: "absent" }));
    await store.recordScan(scanAt(repo, "2026-10-21T00:00:00.000Z", undefined, { linter: "present" }));

    const read = await store.history(repo);

    expect(read.ok).toBe(true);
    expect(read.value?.map((s) => s.scannedAt)).toEqual([
      "2026-10-21T00:00:00.000Z",
      "2026-10-19T00:00:00.000Z",
    ]);
  });

  it("is append-only: a repeated scan of the same moment is one row, not two", async () => {
    const repo = `amm/${randomUUID()}`;
    const stamp = "2026-10-21T00:00:00.000Z";
    const store = open();
    const scan = scanAt(repo, stamp, undefined, { linter: "present" });

    await store.recordScan(scan);
    await store.recordScan(scan);

    const read = await store.history(repo);
    expect(read.value).toHaveLength(1);
  });

  it("REFUSES a signal outside the triad on THIS driver too", async () => {
    const repo = `amm/${randomUUID()}`;
    const store = open();
    const scan = scanAt(repo, "2026-10-21T00:00:00.000Z", undefined, { linter: "present" });
    // A boolean-shaped signal: no `state` at all. Enforcing the triad in one write path only would mean this driver
    // accepts a row the SQLite one refuses, and the schema would carry a shape #426 has to migrate.
    const broken = {
      ...scan,
      pillars: scan.pillars.map((pillar) => ({
        ...pillar,
        signals: (pillar.signals ?? []).map((signal) =>
          signal.id === "linter" ? ({ ...signal, state: undefined } as never) : signal,
        ),
      })),
    } as StoredAmmScan;

    const written = await store.recordScan(broken);

    expect(written.ok).toBe(false);
    expect(written.error).toMatch(/carries state undefined/);
  });

  it("reports a read failure as a failed result rather than throwing", async () => {
    // A closed pool is the honest way to make the query itself fail: the driver's contract is a result object, so a
    // caller decides what to show instead of catching.
    const store = open();
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const read = await store.latestScans({});

    expect(read.ok).toBe(false);
    expect(read.error).toBeTruthy();
  });
});