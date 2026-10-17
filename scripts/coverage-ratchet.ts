/**
 * Dark Factory repo tooling: the unit test coverage ratchet (#391).
 *
 * A committed baseline records the coverage the repository currently achieves; this module decides
 * whether a change DROPPED it. A ratchet rather than a fixed threshold is deliberate: an absolute target
 * would fail on day one on a codebase this size and teach people to ignore the check, whereas a ratchet
 * only ever asks for the floor not to fall.
 *
 * The comparison is PURE so it can be unit-tested without running a coverage suite, and it reads only the
 * `total` block of a coverage summary JSON. That keeps the provider a seam: swapping v8 for istanbul does
 * not touch the gate.
 */

export type CoverageMetricName = "lines" | "statements" | "functions" | "branches";

/** The metrics compared, in report order. */
export const COVERAGE_METRICS: readonly CoverageMetricName[] = [
  "lines",
  "statements",
  "functions",
  "branches",
];

export interface CoverageViolation {
  metric: CoverageMetricName;
  /** `dropped` = the metric fell; `missing` = it could not be read from one side. */
  reason: "dropped" | "missing";
  baselinePct?: number;
  currentPct?: number;
  dropPct?: number;
}

export interface CoverageDelta {
  metric: CoverageMetricName;
  baselinePct: number;
  currentPct: number;
  deltaPct: number;
}

export interface CoverageComparison {
  ok: boolean;
  violations: CoverageViolation[];
  deltas: CoverageDelta[];
  /** True when at least one metric rose, so the caller can suggest recording a new floor. */
  improved: boolean;
}

/**
 * Percentage points of slack, to absorb how the summary rounds to two decimals. Deliberately a parameter
 * rather than an environment variable: the repo's `env-example-coverage` guard reddens on a source read of
 * an undocumented variable, and a gate does not need to be tunable per deployment.
 */
export const DEFAULT_TOLERANCE_PCT = 0.05;

/** Raised when an input is not a coverage summary at all, as opposed to reporting a drop. */
export class CoverageSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageSummaryError";
  }
}

export function compareCoverage(
  _baseline: unknown,
  _current: unknown,
  _tolerancePct: number = DEFAULT_TOLERANCE_PCT,
): CoverageComparison {
  throw new Error("not implemented");
}
