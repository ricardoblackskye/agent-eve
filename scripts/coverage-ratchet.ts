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
  /** The metric's denominator in the baseline, so a grown code base can be told from a regression. */
  baselineTotal?: number;
  /** The metric's denominator in the current run. */
  currentTotal?: number;
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
  report: string;
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
/** Written by the json reporter; the gate reads the run outcome from it. */
export const COVERAGE_REPORT_PATH = "coverage/vitest-report.json";

/**
 * Percentage points of slack, to absorb how the summary rounds to two decimals. Deliberately a parameter
 * rather than an environment variable: the repo's `env-example-coverage` guard reddens on a source read of
 * an undocumented variable, and a gate does not need to be tunable per deployment.
 */
export const DEFAULT_TOLERANCE_PCT = 0.05;

/**
 * Percentage points above which a drop is more likely to be a MEASUREMENT difference than a regression.
 *
 * Measured on this repository, the same suite reports 83.89% of lines with the five Postgres test variables
 * set and 78.34% without them, because the gated suites SKIP without a database - a gap of over 5pp, while
 * an ordinary regression is under 2pp. The committed baseline is the CI figure, so a developer running the
 * gate locally without a database would otherwise see a drop that is entirely an artefact of their setup.
 */
export const SKIPPED_SUITE_DROP_HINT_PCT = 2;

/** Raised when an input is not a coverage summary at all, as opposed to reporting a drop. */
export class CoverageSummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageSummaryError";
  }
}

/**
 * Raised when the coverage came from a test run that did not pass.
 *
 * A failing test does not execute the code it would have covered, so the numbers fall for a reason that
 * has nothing to do with coverage. Measured on this repository, two failing Postgres tests moved lines by
 * 0.28pp - below the tolerance hint and inside the range an ordinary change produces - which failed the
 * gate on a pull request that changed no coverage at all. `--update` is the worse half: run after a
 * failing run it would commit a permanently lower floor.
 */
export class CoverageRunFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageRunFailedError";
  }
}

/** Refuse to read coverage from a run that failed. */
function requireGreenRun(report: unknown, label = "the test report"): void {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new CoverageSummaryError(`${label} is not a Vitest JSON report object.`);
  }
  const failed = (report as { numFailedTests?: unknown }).numFailedTests;
  if (typeof failed !== "number" || !Number.isFinite(failed)) {
    // Fail closed: an unreadable outcome is not a passing one.
    throw new CoverageSummaryError(`${label} has no numeric "numFailedTests".`);
  }
  if (failed > 0 || (report as { success?: unknown }).success === false) {
    throw new CoverageRunFailedError(
      `the test run did not pass (${failed} failing test${failed === 1 ? "" : "s"}), so its coverage is not comparable with the baseline.`,
    );
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

/** One metric's DENOMINATOR, which is what tells a grown code base apart from a regression. */
function readMetricTotal(total: Record<string, unknown>, metric: CoverageMetricName): number | undefined {
  const entry = total[metric];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const value = (entry as { total?: unknown }).total;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Why a metric fell: the code base grew, or coverage of existing code fell.
 *
 * A percentage is a ratio, so the same fraction of a bigger denominator reads LOWER. When the repository gains
 * functions or branches, a metric can fall without a single previously-covered line losing its test - and the gate
 * used to say "Add tests for what this change touched" either way, which sends an author to a diff that cannot be
 * the cause. Naming the denominator is what makes the two cases distinguishable.
 */
export function describeDrop(violation: CoverageViolation): string {
  const dropped = `FAIL: ${violation.metric} dropped ${violation.dropPct?.toFixed(2)}pp, from ${violation.baselinePct?.toFixed(2)}% to ${violation.currentPct?.toFixed(2)}%.`;
  const before = violation.baselineTotal;
  const now = violation.currentTotal;
  if (typeof before === "number" && typeof now === "number" && now > before) {
    return `${dropped} Its denominator grew from ${before} to ${now}, so the code base gained ${violation.metric}: cover the new ones rather than assume a regression in what was already covered.`;
  }
  return `${dropped} Its denominator did not grow, so coverage of existing code fell.`;
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
      violations.push({ metric, reason: "missing", baselinePct, currentPct, baselineTotal: readMetricTotal(baselineTotal, metric), currentTotal: readMetricTotal(currentTotal, metric) });
      continue;
    }

    const deltaPct = Number((currentPct - baselinePct).toFixed(2));
    deltas.push({ metric, baselinePct, currentPct, deltaPct });

    if (deltaPct > 0) improved = true;

    const dropPct = Number((baselinePct - currentPct).toFixed(2));
    if (dropPct > tolerancePct) {
      violations.push({ metric, reason: "dropped", baselinePct, currentPct, dropPct, baselineTotal: readMetricTotal(baselineTotal, metric), currentTotal: readMetricTotal(currentTotal, metric) });
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

  // Refuse a failing run before either mode: gating one reds a pull request that changed no coverage, and
  // updating from one commits a lower floor that the ratchet then defends forever.
  let reportText: string;
  try {
    reportText = io.readFile(paths.report);
  } catch (error) {
    io.log(`FAIL: the test report at ${paths.report} could not be read (${describeError(error)}).`);
    io.log(`      Run \`npm run test:coverage\` first, so the gate knows the run passed.`);
    return 1;
  }
  try {
    requireGreenRun(JSON.parse(reportText));
  } catch (error) {
    io.log(`FAIL: ${describeError(error)}`);
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
          : describeDrop(violation),
      );
    }
    const biggestDrop = Math.max(
      0,
      ...comparison.violations
        .filter((violation) => violation.reason === "dropped")
        .map((violation) => violation.dropPct ?? 0),
    );
    if (biggestDrop > SKIPPED_SUITE_DROP_HINT_PCT) {
      // The hint is the difference between a gate someone fixes and a gate someone disables.
      io.log(
        "A drop this large is usually a MEASUREMENT difference, not a regression: the gated Postgres suites",
      );
      io.log("skip unless the five test variables are set, and every metric then reads points lower.");
      io.log("See the Coverage section of AGENTS.md for the one-command setup.");
    }
    io.log(
      `Coverage must not go backwards. Measured on ${process.platform}; add tests for what this change touched.`,
    );
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
    {
      baseline: COVERAGE_BASELINE_PATH,
      summary: COVERAGE_SUMMARY_PATH,
      report: COVERAGE_REPORT_PATH,
    },
  );
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exitCode = coverageRatchetMain();
}
