/**
 * #382 - AMM scoring: a PURE function from measurements to a scan.
 *
 * The whitepaper's model is unforgiving by design: signals are binary ("present or absent, no partial credit and no
 * subjective judgment"), each worth 1/2/4/8/16 points by level, against thresholds L1 5, L2 19, L3 36, L4 60, L5 100.
 * This module owns the arithmetic and nothing else - it reads the catalogue, never the filesystem - so it can be
 * tested exhaustively, and a wrong weight is a failing test rather than a silently mis-graded repository.
 *
 * THE SCORE IS NORMALISED. The catalogue's weights total more than 100, so the score is the share of the available
 * weight a repository actually carries: `round(100 * earned / possible)`. Everything present is therefore exactly 100
 * (Level 5, the top of the whitepaper's own scale) and nothing can overshoot it.
 *
 * KNOWN DEVIATION, stated rather than hidden: this repository scores 78, where the published scan says 74. Both are
 * Level 4, and the whitepaper does not publish per-signal levels - the 74 comes from the scan itself - so the
 * difference is the LEVELS, which the scanner will measure rather than calibrate.
 */
import { AMM_LEVELS, AMM_FLOOR_LEVEL, type AmmScan, type AmmSignal } from "./amm-readiness";
import {
  AMM_SIGNAL_CATALOGUE,
  AMM_PILLARS,
  AMM_POINT_VALUES,
  catalogueTotal,
  signalsForPillar,
} from "./amm-signals";

export type AmmPillarId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * What a check found. UNMEASURED is a third state, not a synonym for absent: a signal nobody could measure has not
 * been shown missing, and counting it as present would let a repo graduate on ignorance.
 */
export type AmmMeasurement = "present" | "absent" | "unmeasured";

export interface AmmMeasurements {
  readonly [signalId: string]: AmmMeasurement;
}

/** The level the whitepaper's thresholds put this many points at. */
export function levelForPoints(points: number): number {
  let level = 1;
  for (const band of AMM_LEVELS) {
    if (points >= band.points) level = band.level;
  }
  return level;
}

/** The label for a level, as rendered: "Level 4 (Optimized)". */
export function labelForLevel(level: number): string {
  const band = AMM_LEVELS.find((entry) => entry.level === level);
  return band ? `Level ${band.level} (${band.label})` : "Not yet measured";
}

/** The label an unmeasured repository gets, instead of a level it has not earned. */
export const UNMEASURED_LABEL = "Not yet measured";

function normalise(earned: number, possible: number): number {
  if (possible <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((earned / possible) * 100)));
}

export interface ScoreRepoInput {
  repo: string;
  /** Signal id to what its check found. A signal with no entry is UNMEASURED. */
  measurements: AmmMeasurements;
  /**
   * When the scan was taken, supplied by the CALLER. Reading the wall clock here would make the scorer impure, and
   * two identical measurements would stop producing identical scans - which is how a "pristine" rescore starts
   * looking like a change.
   */
  scannedAt: string;
}

/**
 * Score one repository. Pure: the same measurements always produce the same scan, which is what makes the thresholds
 * testable at their boundaries rather than by example.
 */
export function scoreRepo(input: ScoreRepoInput): AmmScan {
  const stateOf = (id: string): AmmMeasurement => input.measurements[id] ?? "unmeasured";

  const pillarOf = (pillar: AmmPillarId) => {
    const definitions = signalsForPillar(pillar);
    const signals: AmmSignal[] = definitions.map((definition) => {
      const state = stateOf(definition.id);
      return {
        id: definition.id,
        label: definition.label,
        present: state === "present" ? true : false,
        state,
        level: definition.level,
      };
    });
    const earned = definitions.reduce(
      (sum, definition) => (stateOf(definition.id) === "present" ? sum + definition.points : sum),
      0,
    );
    const possible = definitions.reduce((sum, definition) => sum + definition.points, 0);
    const unmeasured = signals.every((signal) => signal.state === "unmeasured");
    const level = unmeasured ? 0 : levelForPoints(normalise(earned, possible));
    return {
      id: pillar,
      name: AMM_PILLARS[pillar].name,
      level,
      label: unmeasured ? UNMEASURED_LABEL : labelForLevel(level),
      benchmark: AMM_PILLARS[pillar].benchmark,
      evidence: AMM_PILLARS[pillar].evidence,
      signals,
    };
  };

  const pillars = ([1, 2, 3, 4, 5, 6, 7, 8] as AmmPillarId[]).map(pillarOf);

  const earned = AMM_SIGNAL_CATALOGUE.reduce(
    (sum, definition) => (stateOf(definition.id) === "present" ? sum + definition.points : sum),
    0,
  );
  const possible = catalogueTotal();
  const anythingMeasured = AMM_SIGNAL_CATALOGUE.some(
    (definition) => stateOf(definition.id) !== "unmeasured",
  );
  const points = normalise(earned, possible);
  const level = anythingMeasured ? levelForPoints(points) : 0;

  return {
    repo: input.repo,
    scannedAt: input.scannedAt,
    overall: {
      points,
      maxPoints: 100,
      level,
      label: anythingMeasured ? labelForLevel(level) : UNMEASURED_LABEL,
    },
    pillars,
    capabilities: [],
  };
}

export interface PillarProfileEntry {
  pillar: AmmPillarId;
  name: string;
  current: number;
  target: number;
  gap: number;
}

/** The Level every pillar is aiming at - the whitepaper's end state. */
export const AMM_TARGET_LEVEL = 5;

/**
 * Current versus target per pillar, so a readiness figure becomes a work list: which pillar, how far short, and
 * therefore what to fix next.
 */
export function profileVsTarget(scan: AmmScan): PillarProfileEntry[] {
  return ([1, 2, 3, 4, 5, 6, 7, 8] as AmmPillarId[]).map((pillar) => {
    const found = scan.pillars.find((entry) => entry.id === pillar);
    const current = found?.level ?? 0;
    return {
      pillar,
      name: found?.name ?? AMM_PILLARS[pillar].name,
      current,
      target: AMM_TARGET_LEVEL,
      gap: Math.max(0, AMM_TARGET_LEVEL - current),
    };
  });
}

export interface ReadinessRow {
  repo: string;
  level: number;
}

/**
 * Organizational Readiness: the share of ACTIVE repositories at or above the production floor.
 *
 * A SHARE, deliberately, not an average of levels. "80% of our active repositories are agent-ready" is a decision;
 * a mean of 2.75 is not - and a single Level 5 repository should not be able to flatter a fleet of Level 1s.
 * This is the ONE implementation: R1's repo list reads it too.
 */
export function readinessOf(rows: readonly ReadinessRow[]): {
  atOrAboveFloor: number;
  active: number;
  pct: number;
} {
  const active = rows.length;
  const atOrAboveFloor = rows.filter((row) => row.level >= AMM_FLOOR_LEVEL).length;
  const pct = active === 0 ? 0 : Math.round((atOrAboveFloor / active) * 100);
  return { atOrAboveFloor, active, pct };
}

export { AMM_POINT_VALUES };
