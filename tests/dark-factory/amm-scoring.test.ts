/**
 * #382 — the AMM scoring model: the catalogue as data, and scoring as a pure function.
 *
 * The whitepaper's model is deliberately unforgiving: signals are BINARY ("present or absent, no partial credit and no
 * subjective judgment"), each worth 1/2/4/8/16 points by level, against thresholds L1 5, L2 19, L3 36, L4 60, L5 100.
 * Three consequences are asserted here rather than left as prose:
 *
 *   1. A signal's point value comes FROM its level, so a wrong weight mis-grades a repository silently.
 *   2. If every signal is present the score must be exactly 100, or the scale's top would be unreachable.
 *   3. UNMEASURED is a third state. An unmeasurable signal can never read as present, because a score built on
 *      unknowns flatters itself, and a grade that flatters itself is worse than one that admits ignorance.
 */
import { describe, expect, it } from "vitest";

import { AMM_FLOOR_LEVEL, AMM_LEVELS, type AmmScan } from "../../agent/lib/dark-factory/amm-readiness";
import {
  AMM_SIGNAL_CATALOGUE,
  AMM_POINT_VALUES,
  catalogueTotal,
  signalsForPillar,
} from "../../agent/lib/dark-factory/amm-signals";
import type { AmmPillarId } from "../../agent/lib/dark-factory/amm-scoring";

/** The scan stamp is an input, so every case here is deterministic. */
const STAMP = "2026-10-21T00:00:00.000Z";
import {
  levelForPoints,
  profileVsTarget,
  readinessOf,
  scoreRepo,
} from "../../agent/lib/dark-factory/amm-scoring";

describe("#382 the signal catalogue is data a reviewer can read", () => {
  it("has one row per signal, with unique ids", () => {
    const ids = AMM_SIGNAL_CATALOGUE.map((signal) => signal.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size, "signal ids must be unique, or measurements collide").toBe(
      ids.length,
    );
  });

  it("names an automated check and its whitepaper source for EVERY signal", () => {
    for (const signal of AMM_SIGNAL_CATALOGUE) {
      expect(signal.check, signal.id).toBeTruthy();
      expect(["file", "command"], signal.id).toContain(signal.check.kind);
      expect(signal.source, `${signal.id} must cite where it comes from`).toMatch(/whitepaper/i);
    }
  });

  it("keeps every check automated, so no signal rests on judgement", () => {
    for (const signal of AMM_SIGNAL_CATALOGUE) {
      const value = signal.check.kind === "file" ? signal.check.path : signal.check.command;
      // A check must be something a machine can run: a path or a command, never a sentence of opinion. A row with no
      // path of its own is not unchecked - a layout supplies its location, which the layout guard proves (#426).
      expect(value === undefined || value.trim() !== "", signal.id).toBe(true);
      if (value !== undefined) {
        expect(value, `${signal.id}: checks are paths or commands, not prose`).not.toMatch(
          /\s(is|are|should|ought)\s/i,
        );
      }
    }
  });

  it("covers all eight pillars, each with at least one signal", () => {
    for (let pillar = 1; pillar <= 8; pillar += 1) {
      expect(signalsForPillar(pillar as AmmPillarId).length, `pillar ${pillar}`).toBeGreaterThan(0);
    }
  });

  it("gives every signal a level whose point value IS the signal's worth", () => {
    for (const signal of AMM_SIGNAL_CATALOGUE) {
      expect([1, 2, 3, 4, 5], signal.id).toContain(signal.level);
      expect(signal.points, `${signal.id}: points come from the level`).toBe(
        AMM_POINT_VALUES[signal.level],
      );
    }
    expect(AMM_POINT_VALUES).toEqual({ 1: 1, 2: 2, 3: 4, 4: 8, 5: 16 });
  });

  it("normalises against the whole catalogue, so everything present IS the top of the scale", () => {
    // The catalogue carries more than 100 points of weight, so a raw sum could never top out at the whitepaper's
    // L5 = 100. The score is therefore the SHARE of available weight: everything present scores exactly 100, and
    // nothing can overshoot it.
    expect(catalogueTotal()).toBeGreaterThan(100);
    expect(AMM_LEVELS.at(-1)?.points).toBe(100);

    const everythingPresent = Object.fromEntries(
      AMM_SIGNAL_CATALOGUE.map((signal) => [signal.id, "present" as const]),
    );
    const scan = scoreRepo({ scannedAt: STAMP,  repo: "owner/repo", measurements: everythingPresent });
    expect(scan.overall.points).toBe(100);
    expect(scan.overall.level).toBe(5);
  });
});

describe("#382 scoring is a pure function of the levels", () => {
  it("is pure: the same measurements score the same, twice", () => {
    const measurements = { linter: "present" as const };
    expect(scoreRepo({ scannedAt: STAMP,  repo: "owner/repo", measurements })).toEqual(
      scoreRepo({ scannedAt: STAMP,  repo: "owner/repo", measurements }),
    );
  });

  it("maps every threshold boundary EXACTLY, and never rounds up a grade", () => {
    // The whitepaper's thresholds are the whole model, so each is asserted from both sides.
    expect(levelForPoints(0)).toBe(1);
    expect(levelForPoints(4)).toBe(1);
    expect(levelForPoints(5)).toBe(1);
    expect(levelForPoints(6)).toBe(1);

    expect(levelForPoints(18)).toBe(1);
    expect(levelForPoints(19)).toBe(2);
    expect(levelForPoints(20)).toBe(2);

    expect(levelForPoints(35)).toBe(2);
    expect(levelForPoints(36), "exactly 36 IS Level 3, the production floor").toBe(3);
    expect(levelForPoints(37)).toBe(3);

    expect(levelForPoints(59)).toBe(3);
    expect(levelForPoints(60)).toBe(4);
    expect(levelForPoints(61)).toBe(4);

    expect(levelForPoints(99)).toBe(4);
    expect(levelForPoints(100)).toBe(5);
    expect(levelForPoints(1000)).toBe(5);
    expect(levelForPoints(-5)).toBe(1);
  });

  it("reports the whitepaper's floor as the pass mark", () => {
    expect(levelForPoints(36)).toBeGreaterThanOrEqual(AMM_FLOOR_LEVEL);
    expect(levelForPoints(35)).toBeLessThan(AMM_FLOOR_LEVEL);
  });

  it("returns a scan in the shape the UI already renders", () => {
    const scan: AmmScan = scoreRepo({ scannedAt: STAMP,  repo: "owner/repo", measurements: {} });

    expect(scan.repo).toBe("owner/repo");
    expect(scan.overall.maxPoints).toBe(100);
    expect(scan.pillars).toHaveLength(8);
    for (const pillar of scan.pillars) {
      expect(typeof pillar.id).toBe("number");
      expect(pillar.name).toBeTruthy();
      expect(pillar.label).toBeTruthy();
      expect(Array.isArray(pillar.signals)).toBe(true);
    }
  });
});

describe("#382 unmeasured is not present", () => {
  it("marks a signal with no measurement as unmeasured, NEVER present", () => {
    const scan = scoreRepo({ scannedAt: STAMP,  repo: "owner/repo", measurements: {} });

    const states = scan.pillars.flatMap((pillar) => pillar.signals ?? []);
    expect(states.length).toBe(AMM_SIGNAL_CATALOGUE.length);
    for (const signal of states) {
      expect(signal.state, signal.id).toBe("unmeasured");
      expect(signal.present, `${signal.id}: unmeasured must not read as present`).toBe(false);
    }
  });

  it("gives an unmeasured signal no points, so ignorance cannot earn a grade", () => {
    const scan = scoreRepo({ scannedAt: STAMP,  repo: "owner/repo", measurements: {} });

    expect(scan.overall.points).toBe(0);
    expect(scan.overall.level, "an unmeasured repo must not claim a level").toBe(0);
    expect(scan.overall.label).toMatch(/not yet measured/i);
  });

  it("counts only what was MEASURED, however many signals exist", () => {
    const scan = scoreRepo({ scannedAt: STAMP, 
      repo: "owner/repo",
      measurements: { linter: "present", formatter: "absent" },
    });
    const signals = scan.pillars.flatMap((pillar) => pillar.signals ?? []);
    const measured = signals.filter((signal) => signal.state !== "unmeasured");

    expect(measured).toHaveLength(2);
    expect(scan.overall.points).toBe(AMM_POINT_VALUES[1]);
  });

  it("distinguishes absent from unmeasured in the scan it produces", () => {
    const scan = scoreRepo({ scannedAt: STAMP, 
      repo: "owner/repo",
      measurements: { linter: "present", formatter: "absent" },
    });
    const byId = new Map(
      scan.pillars.flatMap((pillar) => pillar.signals ?? []).map((s) => [s.id, s]),
    );

    expect(byId.get("linter")?.state).toBe("present");
    expect(byId.get("formatter")?.state).toBe("absent");
    expect(byId.get("type-checker")?.state).toBe("unmeasured");
  });
});

describe("#382 the profile reports current against the target", () => {
  it("gives every pillar a current level and the Level 5 target", () => {
    const scan = scoreRepo({ scannedAt: STAMP,  repo: "owner/repo", measurements: {} });
    const profile = profileVsTarget(scan);

    expect(profile).toHaveLength(8);
    for (const entry of profile) {
      expect(entry.target).toBe(5);
      expect(entry.current).toBeGreaterThanOrEqual(0);
      expect(entry.pillar).toBeGreaterThanOrEqual(1);
    }
  });

  it("reports a gap per pillar, so the work is a list rather than a number", () => {
    const scan = scoreRepo({ scannedAt: STAMP,  repo: "owner/repo", measurements: {} });
    for (const entry of profileVsTarget(scan)) {
      expect(entry.gap).toBe(entry.target - entry.current);
      expect(entry.gap).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("#382 Organizational Readiness is a share, not an average", () => {
  it("is the share of ACTIVE repositories at or above the floor", () => {
    const readiness = readinessOf([
      { repo: "a/one", level: 5 },
      { repo: "a/two", level: 3 },
      { repo: "a/three", level: 2 },
      { repo: "a/four", level: 1 },
    ]);

    // A mean of levels would be 2.75 here, which is not a number leadership can act on.
    expect(readiness).toEqual({ atOrAboveFloor: 2, active: 4, pct: 50 });
  });

  it("is 0 with no active repositories rather than a division by zero", () => {
    expect(readinessOf([])).toEqual({ atOrAboveFloor: 0, active: 0, pct: 0 });
  });

  it("is 100 when every active repository clears the floor", () => {
    expect(
      readinessOf([
        { repo: "a/one", level: 3 },
        { repo: "a/two", level: 5 },
      ]).pct,
    ).toBe(100);
  });

  it("counts a repo AT the floor as ready, because Level 3 is the bar", () => {
    expect(readinessOf([{ repo: "a/one", level: AMM_FLOOR_LEVEL }]).pct).toBe(100);
  });
});
