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
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

/** Defaults, relative to the repository root. */
export const COVERAGE_BASELINE_PATH = "coverage-baseline.json";
export const COVERAGE_SUMMARY_PATH = "coverage/coverage-summary.json";

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A metric-by-metric table, padded so the columns line up in a terminal and in a CI log. */
function formatTable(deltas: CoverageDelta[]): string {
  const header = ["metric", "baseline", "current", "delta"];
  const rows = deltas.map((delta) => [
    delta.metric,
    `${delta.baselinePct.toFixed(2)}%`,
    `${delta.currentPct.toFixed(2)}%`,
    `${delta.deltaPct >= 0 ? "+" : ""}${delta.deltaPct.toFixed(2)}pp`,
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

/**
 * Run the gate. Returns the process exit code.
 *
 * Order is deliberate: the SUMMARY is required in both modes, so `--update` cannot record a baseline from
 * a summary that was never produced, and a plain check fails first on the input the coverage run creates
 * rather than on the file a human has to commit.
 */
export function runCoverageRatchet(
  argv: readonly string[],
  io: CoverageRatchetIO,
  paths: CoverageRatchetPaths,
): number {
  const update = argv.includes("--update");

  let currentText: string;
  try {
    currentText = io.readFile(paths.summary);
  } catch (error) {
    io.log(`FAIL: the coverage summary at ${paths.summary} could not be read (${describeError(error)}).`);
    io.log("      Run `npm run test:coverage` first: the gate compares what that produces.");
    return 1;
  }

  let current: unknown;
  try {
    current = JSON.parse(currentText);
  } catch (error) {
    io.log(`FAIL: the coverage summary at ${paths.summary} is not valid JSON (${describeError(error)}).`);
    return 1;
  }

  if (update) {
    // Only the total block is stored: the baseline is a floor, not a second copy of the whole report.
    let total: unknown;
    try {
      total = readTotal(current, "the coverage summary");
    } catch (error) {
      io.log(`FAIL: ${describeError(error)}`);
      return 1;
    }
    io.writeFile(paths.baseline, `${JSON.stringify({ total }, null, 2)}\n`);
    io.log(`Wrote the new coverage baseline to ${paths.baseline}.`);
    return 0;
  }

  let baselineText: string;
  try {
    baselineText = io.readFile(paths.baseline);
  } catch (error) {
    io.log(`FAIL: the coverage baseline at ${paths.baseline} could not be read (${describeError(error)}).`);
    io.log("      Record one with `npm run coverage:ratchet -- --update` and commit it.");
    return 1;
  }

  let baseline: unknown;
  try {
    baseline = JSON.parse(baselineText);
  } catch (error) {
    io.log(`FAIL: the coverage baseline at ${paths.baseline} is not valid JSON (${describeError(error)}).`);
    return 1;
  }

  let comparison: CoverageComparison;
  try {
    comparison = compareCoverage(baseline, current);
  } catch (error) {
    io.log(`FAIL: ${describeError(error)}`);
    return 1;
  }

  if (comparison.deltas.length > 0) io.log(formatTable(comparison.deltas));

  if (!comparison.ok) {
    for (const violation of comparison.violations) {
      io.log(
        violation.reason === "missing"
          ? `FAIL: ${violation.metric} could not be read from the baseline and the summary, so the gate cannot verify it.`
          : `FAIL: ${violation.metric} dropped ${violation.dropPct?.toFixed(2)}pp, from ${violation.baselinePct?.toFixed(2)}% to ${violation.currentPct?.toFixed(2)}%.`,
      );
    }
    io.log("Coverage must not go backwards. Add tests for what this change touched.");
    return 1;
  }

  if (comparison.improved) {
    io.log("Coverage improved. Record the new floor with `npm run coverage:ratchet -- --update`.");
  }
  return 0;
}

/** The CLI entry point: real filesystem, real stdout. */
export function coverageRatchetMain(argv: readonly string[] = process.argv.slice(2)): number {
  return runCoverageRatchet(
    argv,
    {
      readFile: (path) => readFileSync(path, "utf8"),
      writeFile: (path, contents) => writeFileSync(path, contents),
      log: (line) => console.log(line),
    },
    { baseline: COVERAGE_BASELINE_PATH, summary: COVERAGE_SUMMARY_PATH },
  );
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exitCode = coverageRatchetMain();
}
