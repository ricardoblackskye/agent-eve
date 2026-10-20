/**
 * #413 (epic #403 R1) — the repo list rule and the leadership metric.
 *
 * "Hooked into the system" = a repo set in the runner's allowed-repo config AND which has had its first AMM
 * readiness scan. The fixture provider returns a scan for every configured repo, so in the mocked phase the list
 * equals the config — but the FILTER is real, and these tests prove both halves rather than only the happy path.
 */
import { describe, expect, it } from "vitest";

import {
  fixtureAmmProvider,
  listedRepos,
  organizationalReadiness,
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
    expect(organizationalReadiness(rows)).toEqual({ atOrAboveFloor: 3, active: 4, pct: 75 });
  });

  it("does not treat below-Level-3 as a pass", async () => {
    const rows = await listedRepos({ configured: "a/one", provider: providerWith([scan("a/one", 2)]) });
    expect(organizationalReadiness(rows).pct).toBe(0);
    expect(organizationalReadiness(rows).atOrAboveFloor).toBe(0);
  });

  it("is 0 with no repos rather than dividing by zero", () => {
    expect(organizationalReadiness([])).toEqual({ atOrAboveFloor: 0, active: 0, pct: 0 });
  });
});
