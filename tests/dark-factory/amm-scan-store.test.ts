/**
 * #424 — AMM scans must survive storage without losing a state.
 *
 * The load-bearing assertion is the TRIAD. #426 (the runner) is not built yet, and the one thing it changes is
 * `state`, because the runner is what decides that a check which could NOT RUN is unmeasured rather than absent. So a
 * schema that stores a boolean `present` would collapse the distinction on the way to disk, and #426 would then have
 * to migrate it back out. Every test here is written so that a two-state shape fails.
 *
 * The other half is attribution: a readiness figure computed across two tenants is wrong for both, and wrong
 * silently - which is the kind of number a board deck gets built on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  comparable,
  SqliteAmmScanStore,
  toStoredScan,
} from "../../agent/lib/dark-factory/amm-scan-store";
import { databaseAmmProvider } from "../../agent/lib/dark-factory/amm-scan-provider";
import { catalogueVersion } from "../../agent/lib/dark-factory/amm-signals";
import {
  readinessOf,
  scoreRepo,
  type AmmMeasurements,
} from "../../agent/lib/dark-factory/amm-scoring";

const STAMP = "2026-10-21T00:00:00.000Z";
const directories: string[] = [];
const stores: SqliteAmmScanStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createStore(): SqliteAmmScanStore {
  const directory = mkdtempSync(join(tmpdir(), "df-amm-scan-"));
  directories.push(directory);
  const store = new SqliteAmmScanStore(join(directory, "scans.sqlite"));
  stores.push(store);
  return store;
}

/** A scored scan, stamped as the provider would store it. */
function scanAt(
  repo: string,
  scannedAt: string,
  tenantId: string | undefined,
  measurements: AmmMeasurements = {},
) {
  return toStoredScan(scoreRepo({ repo, measurements, scannedAt }), tenantId);
}

function statesOf(scan: { pillars: readonly { signals?: readonly { id: string; state?: string }[] }[] }) {
  return new Map(
    scan.pillars.flatMap((pillar) => pillar.signals ?? []).map((signal) => [signal.id, signal.state]),
  );
}

describe("#424 the triad survives storage", () => {
  it("round-trips present, absent AND unmeasured without collapsing any of them", async () => {
    const store = createStore();
    await store.recordScan(
      scanAt("a/one", STAMP, "tenant-1", { linter: "present", formatter: "absent" }),
    );

    const read = await store.latestScans();
    const states = statesOf(read.value?.[0] ?? { pillars: [] });

    expect(states.get("linter")).toBe("present");
    expect(states.get("formatter")).toBe("absent");
    expect(states.get("type-checker")).toBe("unmeasured");
    // The regression this exists to catch: unmeasured coming back as absent.
    expect(states.get("type-checker")).not.toBe("absent");
  });

  it("stores a signal's level and points too, so a score can be explained later", async () => {
    const store = createStore();
    await store.recordScan(scanAt("a/one", STAMP, "tenant-1", { linter: "present" }));

    const read = await store.latestScans();
    const signals = (read.value?.[0]?.pillars ?? []).flatMap((pillar) => pillar.signals ?? []);
    const linter = signals.find((signal) => signal.id === "linter");

    expect(linter?.level).toBeGreaterThanOrEqual(1);
    expect(linter?.points).toBeGreaterThan(0);
    expect(signals.length).toBeGreaterThan(1);

    const unmeasured = signals.find((signal) => signal.state === "unmeasured");
    expect(unmeasured, "an unmeasured signal is stored with its weight, not dropped").toBeTruthy();
  });
});

describe("#424 a scan is attributed to its tenant", () => {
  it("never mixes two tenants' scans, even for the same repository", async () => {
    const store = createStore();
    await store.recordScan(scanAt("shared/repo", "2026-10-21T00:00:00.000Z", "tenant-1"));
    await store.recordScan(scanAt("shared/repo", "2026-10-21T01:00:00.000Z", "tenant-2"));

    const one = await store.latestScans({ tenantId: "tenant-1" });
    const two = await store.latestScans({ tenantId: "tenant-2" });

    expect(one.value?.map((scan) => scan.tenantId)).toEqual(["tenant-1"]);
    expect(two.value?.map((scan) => scan.tenantId)).toEqual(["tenant-2"]);
    expect(one.value?.[0]?.scannedAt).toBe("2026-10-21T00:00:00.000Z");
    expect(two.value?.[0]?.scannedAt).toBe("2026-10-21T01:00:00.000Z");
  });

  it("keeps readiness per tenant, so one customer's share is not another's", async () => {
    const store = createStore();
    await store.recordScan(scanAt("a/one", STAMP, "tenant-1"));
    await store.recordScan(scanAt("a/two", STAMP, "tenant-2"));

    const rowsFor = async (tenantId: string) =>
      (await store.latestScans({ tenantId })).value?.map((scan) => ({
        repo: scan.repo,
        level: scan.level,
      })) ?? [];

    expect(readinessOf(await rowsFor("tenant-1")).active).toBe(1);
    expect(readinessOf(await rowsFor("tenant-2")).active).toBe(1);
    expect(readinessOf(await rowsFor("tenant-1")).active).not.toBe(2);
  });
});

describe("#424 history is append-only and the latest wins", () => {
  it("keeps every scan for a repository and reads back the newest", async () => {
    const store = createStore();
    await store.recordScan(scanAt("a/one", "2026-10-20T00:00:00.000Z", "tenant-1", {}));
    await store.recordScan(
      scanAt("a/one", "2026-10-21T00:00:00.000Z", "tenant-1", { linter: "present" }),
    );

    const history = await store.history("a/one", { tenantId: "tenant-1" });
    expect(history.value?.map((scan) => scan.scannedAt)).toEqual([
      "2026-10-21T00:00:00.000Z",
      "2026-10-20T00:00:00.000Z",
    ]);

    const latest = await store.latestScans({ tenantId: "tenant-1" });
    expect(latest.value?.[0]?.scannedAt).toBe("2026-10-21T00:00:00.000Z");
    expect(latest.value?.[0]?.points).toBeGreaterThan(0);
  });
});

describe("#424 every score records the catalogue that produced it", () => {
  it("stamps the current catalogue version on the stored scan", async () => {
    const store = createStore();
    await store.recordScan(scanAt("a/one", STAMP, "tenant-1"));

    const read = await store.latestScans();
    expect(read.value?.[0]?.catalogueVersion).toBe(catalogueVersion());
  });

  it("REFUSES to compare scores from different catalogue versions", async () => {
    const store = createStore();
    await store.recordScan(scanAt("a/one", STAMP, "tenant-1"));
    const newer = scanAt("a/two", STAMP, "tenant-1");
    const otherVersion = { ...newer, catalogueVersion: "not-the-current-one" };

    const rows = [read0(await store.latestScans()), otherVersion];

    // A trend drawn across a weight change is an artifact, not a measurement.
    expect(() => comparable(rows)).toThrow();
    expect(comparable([rows[0]])).toBe(true);
  });
});

describe("#424 nothing is fabricated for an unscanned repository", () => {
  it("returns undefined rather than a level a repository has not earned", async () => {
    const store = createStore();
    const provider = databaseAmmProvider(store);

    expect(await provider.scan("a/never-scanned")).toBeUndefined();
  });

  it("returns the stored scan for a repository that has one", async () => {
    const store = createStore();
    await store.recordScan(scanAt("a/one", STAMP, "tenant-1", { linter: "present" }));
    const provider = databaseAmmProvider(store);

    const scan = await provider.scan("a/one");
    expect(scan?.repo).toBe("a/one");
    expect(scan?.overall.points).toBeGreaterThan(0);
    expect(scan?.pillars.length).toBe(8);
  });
});

function read0(result: { value?: readonly never[] | null }): never {
  return (result.value ?? [])[0] as never;
}
