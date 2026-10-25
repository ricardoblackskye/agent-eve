/**
 * #413 (epic #403 R1) — the repo list rule and the leadership metric.
 *
 * "Hooked into the system" = a repo set in the runner's allowed-repo config AND which has had its first AMM
 * readiness scan. The fixture provider returns a scan for every configured repo, so in the mocked phase the list
 * equals the config — but the FILTER is real, and these tests prove both halves rather than only the happy path.
 */
import { describe, expect, it } from "vitest";

import { readinessOf } from "../../agent/lib/dark-factory/amm-scoring";
import {
  AMM_FLOOR_LEVEL,
  agentEveScan,
  fixtureAmmProvider,
  listedRepos,

  type AmmScan,
} from "../../agent/lib/dark-factory/amm-readiness";

function scan(repo: string, level = 4): AmmScan {
  return {
    repo,
    scannedAt: "2026-10-19T00:00:00.000Z",
    overall: { points: 74, maxPoints: 100, level, label: `Level ${level} (Optimized)` },
    pillars: [],
    capabilities: [],
  };
}

const providerWith = (scans: AmmScan[]) => fixtureAmmProvider(scans);

describe("#413 the repo list rule", () => {
  it("lists a repo that is BOTH configured and scanned", async () => {
    const rows = await listedRepos({
      configured: "ricardoblackskye/agent-eve",
      provider: providerWith([scan("ricardoblackskye/agent-eve")]),
    });
    expect(rows.map((row) => row.repo)).toEqual(["ricardoblackskye/agent-eve"]);
    expect(rows[0].level).toBe(4);
  });

  it("does NOT list a configured repo that has no scan", async () => {
    const rows = await listedRepos({
      configured: "ricardoblackskye/agent-eve,ricardoblackskye/WebFeedPOC",
      provider: providerWith([scan("ricardoblackskye/agent-eve")]),
    });
    expect(rows.map((row) => row.repo)).toEqual(["ricardoblackskye/agent-eve"]);
  });

  it("does NOT list a scanned repo that is not configured", async () => {
    const rows = await listedRepos({
      configured: "ricardoblackskye/agent-eve",
      provider: providerWith([scan("ricardoblackskye/agent-eve"), scan("someone/other")]),
    });
    expect(rows.map((row) => row.repo)).toEqual(["ricardoblackskye/agent-eve"]);
  });

  it("normalizes config entries and collapses duplicates", async () => {
    const rows = await listedRepos({
      configured: " Ricardoblackskye/Agent-Eve , ricardoblackskye/agent-eve ,, ",
      provider: providerWith([scan("ricardoblackskye/agent-eve")]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe("ricardoblackskye/agent-eve");
  });

  it("is empty, not broken, when nothing is configured", async () => {
    const rows = await listedRepos({ configured: "", provider: providerWith([scan("a/b")]) });
    expect(rows).toEqual([]);
  });
});

describe("#413 organizational readiness", () => {
  it("is the share of active repos at Level 3 or above", async () => {
    const rows = await listedRepos({
      configured: "a/one,a/two,a/three,a/four",
      provider: providerWith([
        scan("a/one", 4),
        scan("a/two", 5),
        scan("a/three", 2),
        scan("a/four", 3),
      ]),
    });
    expect(readinessOf(rows)).toEqual({ atOrAboveFloor: 3, active: 4, pct: 75 });
  });

  it("does not treat below-Level-3 as a pass", async () => {
    const rows = await listedRepos({ configured: "a/one", provider: providerWith([scan("a/one", 2)]) });
    expect(readinessOf(rows).pct).toBe(0);
    expect(readinessOf(rows).atOrAboveFloor).toBe(0);
  });

  it("is 0 with no repos rather than dividing by zero", () => {
    expect(readinessOf([])).toEqual({ atOrAboveFloor: 0, active: 0, pct: 0 });
  });
});

describe("#413 the fixture scan", () => {
  it("records the figures from the whitepaper scan of this repo", () => {
    const scan = agentEveScan();
    expect(scan.repo).toBe("ricardoblackskye/agent-eve");
    expect(scan.overall).toMatchObject({ points: 74, maxPoints: 100, level: 4 });
    expect(scan.overall.label).toBe("Level 4 (Optimized)");
    expect(scan.pillars).toHaveLength(8);
    expect(scan.pillars.map((entry) => entry.level)).toEqual([4, 4, 4, 5, 4, 4, 4, 4.5]);
    expect(scan.capabilities.length).toBeGreaterThan(0);
  });

  it("keeps every pillar at or above the production floor", () => {
    for (const entry of agentEveScan().pillars) {
      expect(entry.level, entry.name).toBeGreaterThanOrEqual(AMM_FLOOR_LEVEL);
    }
  });

  it("serves that scan for this repo and nothing for a repo with no scan", async () => {
    const provider = fixtureAmmProvider([agentEveScan()]);
    expect((await provider.scan("ricardoblackskye/agent-eve"))?.overall.points).toBe(74);
    expect(await provider.scan("someone/else")).toBeUndefined();
  });

  it("exposes NO default provider, so no caller can quietly fall back to the fixture (#465)", async () => {
    // The fixture stays reachable for tests, but there must be no zero-argument factory that returns it: a page
    // wired to one renders a hard-coded measurement, which is the whole defect #465 was filed for.
    const surface = await import("../../agent/lib/dark-factory/amm-readiness");
    expect("defaultAmmProvider" in surface).toBe(false);
  });
});

/**
 * #415 (epic #403 R3) — the fixture has to carry the SIGNALS, not just the levels.
 *
 * The whitepaper's model scores binary signals, each worth its level's points, so a scale showing only "Level 4" hides
 * the thing that produced it. These pin the shape the scale renders and fail while the fixture still reports empty
 * benchmarks and no signals at all.
 */
describe("#415 the fixture's signal catalogue", () => {
  it("carries binary signals per pillar, each with the level that gives it its point value", () => {
    for (const scanPillar of agentEveScan().pillars) {
      expect(scanPillar.signals?.length, scanPillar.name).toBeGreaterThan(0);
      for (const signal of scanPillar.signals ?? []) {
        expect(typeof signal.present, signal.label).toBe("boolean");
        expect(signal.level, signal.label).toBeGreaterThanOrEqual(1);
        expect(signal.level, signal.label).toBeLessThanOrEqual(5);
      }
    }
  });

  it("keeps a benchmark with each pillar, so the scale can say WHY a level was earned", () => {
    for (const scanPillar of agentEveScan().pillars) {
      expect(scanPillar.benchmark.length, scanPillar.name).toBeGreaterThan(0);
    }
  });
});
