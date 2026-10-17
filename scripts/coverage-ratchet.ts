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

/**
 * The `total` block of a summary.
 *
 * A summary with no `total` is not a summary, so this THROWS rather than reporting a violation: "I cannot
 * read my input" and "coverage fell" are different failures, and collapsing them would report a broken
 * file as a coverage regression.
 */
function readTotal(summary: unknown, label: string): Record<string, unknown> {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    throw new CoverageSummaryError(
      `${label} is not a coverage summary object. Expected the JSON written by the json-summary reporter.`,
    );
  }
  const total = (summary as { total?: unknown }).total;
  if (total === null || typeof total !== "object" || Array.isArray(total)) {
    throw new CoverageSummaryError(
      `${label} has no "total" block. Expected the JSON written by the json-summary reporter.`,
    );
  }
  return total as Record<string, unknown>;
}

/**
 * One metric's percentage.
 *
 * ABSENT and MALFORMED are deliberately different. An absent key is reported by the caller as a `missing`
 * violation, so the gate fails closed on an incomplete summary; a key that is present but not a numeric
 * percentage means the file is not a summary, so it throws. Treating absent as 0, or malformed as absent,
 * would both let a gate pass on input it could not actually verify.
 */
function readPct(
  total: Record<string, unknown>,
  metric: CoverageMetricName,
  label: string,
): number | undefined {
  if (!(metric in total)) return undefined;
  const entry = total[metric];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new CoverageSummaryError(`${label} has a "${metric}" entry that is not an object.`);
  }
  const pct = (entry as { pct?: unknown }).pct;
  if (typeof pct !== "number" || !Number.isFinite(pct)) {
    throw new CoverageSummaryError(`${label} has a "${metric}" entry with no numeric "pct".`);
  }
  return pct;
}

/** Compare a baseline summary against the current one. */
export function compareCoverage(
  baseline: unknown,
  current: unknown,
  tolerancePct: number = DEFAULT_TOLERANCE_PCT,
): CoverageComparison {
  const baselineTotal = readTotal(baseline, "the baseline");
  const currentTotal = readTotal(current, "the current summary");

  const violations: CoverageViolation[] = [];
  const deltas: CoverageDelta[] = [];
  let improved = false;

  for (const metric of COVERAGE_METRICS) {
    const baselinePct = readPct(baselineTotal, metric, "the baseline");
    const currentPct = readPct(currentTotal, metric, "the current summary");

    if (baselinePct === undefined || currentPct === undefined) {
      violations.push({ metric, reason: "missing", baselinePct, currentPct });
      continue;
    }

    const deltaPct = Number((currentPct - baselinePct).toFixed(2));
    deltas.push({ metric, baselinePct, currentPct, deltaPct });

    if (deltaPct > 0) improved = true;

    const dropPct = Number((baselinePct - currentPct).toFixed(2));
    if (dropPct > tolerancePct) {
      violations.push({ metric, reason: "dropped", baselinePct, currentPct, dropPct });
    }
  }

  return { ok: violations.length === 0, violations, deltas, improved };
}

/** Where the two files live. Injected so the CLI is testable without a filesystem. */
export interface CoverageRatchetPaths {
  baseline: string;
  summary: string;
}

/** The file access and logging the CLI needs. Injected for the same reason. */
export interface CoverageRatchetIO {
  readFile: (path: string) => string;
  writeFile: (path: string, contents: string) => void;
  log: (line: string) => void;
}

/** Exit code 0 when the floor held, non-zero when it moved or could not be verified. */
export function runCoverageRatchet(
  _argv: readonly string[],
  _io: CoverageRatchetIO,
  _paths: CoverageRatchetPaths,
): number {
  throw new Error("not implemented");
}
