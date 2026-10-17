import { describe, expect, it } from "vitest";
import {
  COVERAGE_METRICS,
  CoverageSummaryError,
  compareCoverage,
  runCoverageRatchet,
} from "../scripts/coverage-ratchet";

/** A coverage summary shaped like the one `json-summary` writes. */
function summary(overrides: Partial<Record<string, number>>, total = 1000) {
  const make = (pct: number) => ({ total, covered: Math.round((total * pct) / 100), skipped: 0, pct });
  return {
    total: {
      lines: make(overrides.lines ?? 78.34),
      statements: make(overrides.statements ?? 77.85),
      functions: make(overrides.functions ?? 80.22),
      branches: make(overrides.branches ?? 72.3),
    },
  };
}

const BASELINE = summary({});

describe("compareCoverage", () => {
  it("passes when nothing changed", () => {
    const result = compareCoverage(BASELINE, summary({}));
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.improved).toBe(false);
  });

  it("FAILS when a metric drops, naming that metric and both numbers", () => {
    const result = compareCoverage(BASELINE, summary({ lines: 76.0 }));
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].metric).toBe("lines");
    expect(result.violations[0].reason).toBe("dropped");
    expect(result.violations[0].baselinePct).toBe(78.34);
    expect(result.violations[0].currentPct).toBe(76.0);
  });

  it("fails for a drop in ANY of the four metrics", () => {
    for (const metric of COVERAGE_METRICS) {
      const result = compareCoverage(BASELINE, summary({ [metric]: 50 }));
      expect(result.ok, `${metric} should gate`).toBe(false);
      expect(result.violations.map((v) => v.metric)).toContain(metric);
    }
  });

  it("passes when coverage rises, and reports that it improved", () => {
    const result = compareCoverage(BASELINE, summary({ lines: 90, branches: 90 }));
    expect(result.ok).toBe(true);
    expect(result.improved).toBe(true);
  });

  it("absorbs rounding noise within the tolerance", () => {
    // 78.34 -> 78.32 is a 0.02pp move, below the 0.05 default: the summary rounds, and a gate that
    // fired on rounding would be dismissed as flaky.
    const result = compareCoverage(BASELINE, summary({ lines: 78.32 }));
    expect(result.ok).toBe(true);
  });

  it("fails for a drop just OVER the tolerance", () => {
    const result = compareCoverage(BASELINE, summary({ lines: 78.2 }));
    expect(result.ok).toBe(false);
  });

  it("honours a custom tolerance", () => {
    expect(compareCoverage(BASELINE, summary({ lines: 78.2 }), 0.5).ok).toBe(true);
    expect(compareCoverage(BASELINE, summary({ lines: 78.0 }), 0.1).ok).toBe(false);
  });

  it("treats a metric MISSING from the current summary as a violation, not a pass", () => {
    const current = summary({});
    delete (current.total as Record<string, unknown>).branches;
    const result = compareCoverage(BASELINE, current);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.reason)).toContain("missing");
    expect(result.violations.map((v) => v.metric)).toContain("branches");
  });

  it("treats a metric MISSING from the baseline as a violation, not a pass", () => {
    const baseline = summary({});
    delete (baseline.total as Record<string, unknown>).functions;
    const result = compareCoverage(baseline, summary({}));
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.metric)).toContain("functions");
  });

  it("reports a delta for every metric, so the table is complete", () => {
    const result = compareCoverage(BASELINE, summary({ lines: 80.0 }));
    expect(result.deltas.map((d) => d.metric).sort()).toEqual([...COVERAGE_METRICS].sort());
    const lines = result.deltas.find((d) => d.metric === "lines");
    expect(lines?.deltaPct).toBeCloseTo(1.66, 2);
  });

  it("refuses a summary with no total block rather than passing it", () => {
    // A valid pair passes FIRST, so this failure cannot be the stub throwing for everything.
    expect(compareCoverage(BASELINE, summary({})).ok).toBe(true);
    expect(() => compareCoverage({}, summary({}))).toThrow(CoverageSummaryError);
    expect(() => compareCoverage(BASELINE, {})).toThrow(/total/i);
  });

  it("refuses a non-object summary rather than passing it", () => {
    expect(compareCoverage(BASELINE, summary({})).ok).toBe(true);
    expect(() => compareCoverage(null, summary({}))).toThrow(CoverageSummaryError);
    expect(() => compareCoverage(BASELINE, "not a summary")).toThrow(CoverageSummaryError);
  });

  it("refuses a total block whose metric is not an object", () => {
    expect(compareCoverage(BASELINE, summary({})).ok).toBe(true);
    const broken = { total: { lines: 78, statements: 77, functions: 80, branches: 72 } };
    expect(() => compareCoverage(BASELINE, broken)).toThrow(CoverageSummaryError);
  });
});


/** The gate around the comparison. IO is injected, so nothing here touches the disk. */
describe("runCoverageRatchet", () => {
  const PATHS = { baseline: "coverage-baseline.json", summary: "coverage/coverage-summary.json" };

  function harness(files: Record<string, string>) {
    const written: Record<string, string> = {};
    const lines: string[] = [];
    return {
      written,
      lines,
      output: () => lines.join("\n"),
      deps: {
        readFile: (p: string) => {
          if (p in files) return files[p];
          throw new Error(`ENOENT: no such file or directory, open '${p}'`);
        },
        writeFile: (p: string, contents: string) => {
          written[p] = contents;
        },
        log: (line: string) => {
          lines.push(line);
        },
      },
    };
  }

  it("exits 0 when coverage holds", () => {
    const h = harness({
      [PATHS.baseline]: JSON.stringify(BASELINE),
      [PATHS.summary]: JSON.stringify(summary({})),
    });
    expect(runCoverageRatchet([], h.deps, PATHS)).toBe(0);
  });

  it("exits 1 on a drop, naming the metric and both percentages", () => {
    const h = harness({
      [PATHS.baseline]: JSON.stringify(BASELINE),
      [PATHS.summary]: JSON.stringify(summary({ lines: 76 })),
    });
    expect(runCoverageRatchet([], h.deps, PATHS)).toBe(1);
    expect(h.output()).toMatch(/lines/);
    expect(h.output()).toMatch(/76/);
    expect(h.output()).toMatch(/78\.34/);
    expect(h.output()).toMatch(/dropped/i);
  });

  it("exits 1 when the summary is missing, and says how to produce one", () => {
    const h = harness({ [PATHS.baseline]: JSON.stringify(BASELINE) });
    expect(runCoverageRatchet([], h.deps, PATHS)).toBe(1);
    expect(h.output()).toMatch(/test:coverage/);
    expect(h.output()).toContain(PATHS.summary);
  });

  it("exits 1 when the baseline is missing, and says how to record one", () => {
    const h = harness({ [PATHS.summary]: JSON.stringify(summary({})) });
    expect(runCoverageRatchet([], h.deps, PATHS)).toBe(1);
    expect(h.output()).toContain(PATHS.baseline);
    expect(h.output()).toMatch(/--update/);
  });

  it("exits 1 when the baseline is not valid JSON", () => {
    const h = harness({
      [PATHS.baseline]: "{ not json",
      [PATHS.summary]: JSON.stringify(summary({})),
    });
    expect(runCoverageRatchet([], h.deps, PATHS)).toBe(1);
    expect(h.output()).toMatch(/JSON/i);
  });

  it("exits 1 when the summary is not valid JSON", () => {
    const h = harness({
      [PATHS.baseline]: JSON.stringify(BASELINE),
      [PATHS.summary]: "not json at all",
    });
    expect(runCoverageRatchet([], h.deps, PATHS)).toBe(1);
    expect(h.output()).toMatch(/JSON/i);
  });

  it("writes the baseline with --update and exits 0, without needing one to exist", () => {
    const h = harness({ [PATHS.summary]: JSON.stringify(summary({ lines: 90 })) });
    expect(runCoverageRatchet(["--update"], h.deps, PATHS)).toBe(0);
    expect(h.written[PATHS.baseline]).toBeDefined();
    const written = JSON.parse(h.written[PATHS.baseline]);
    expect(written.total.lines.pct).toBe(90);
    expect(h.output()).toMatch(/baseline/i);
  });

  it("exits 0 on an improvement and suggests recording the new floor", () => {
    const h = harness({
      [PATHS.baseline]: JSON.stringify(BASELINE),
      [PATHS.summary]: JSON.stringify(summary({ lines: 90 })),
    });
    expect(runCoverageRatchet([], h.deps, PATHS)).toBe(0);
    expect(h.output()).toMatch(/improved/i);
    expect(h.output()).toMatch(/--update/);
  });

  it("prints a row for every metric, so the table is complete", () => {
    const h = harness({
      [PATHS.baseline]: JSON.stringify(BASELINE),
      [PATHS.summary]: JSON.stringify(summary({})),
    });
    runCoverageRatchet([], h.deps, PATHS);
    for (const metric of COVERAGE_METRICS) {
      expect(h.output()).toContain(metric);
    }
  });

  it("explains a missing-suite sized drop instead of leaving it looking like a regression", () => {
    const h = harness({
      [PATHS.baseline]: JSON.stringify(BASELINE),
      [PATHS.summary]: JSON.stringify(summary({ lines: 75 })),
    });
    expect(runCoverageRatchet([], h.deps, PATHS)).toBe(1);
    expect(h.output()).toMatch(/Postgres/i);
    expect(h.output()).toMatch(/skip/i);
    expect(h.output()).toMatch(/not a regression|measurement/i);
  });

  it("does NOT offer that explanation for an ordinary drop, so the hint stays meaningful", () => {
    const h = harness({
      [PATHS.baseline]: JSON.stringify(BASELINE),
      [PATHS.summary]: JSON.stringify(summary({ lines: 77.5 })),
    });
    expect(runCoverageRatchet([], h.deps, PATHS)).toBe(1);
    expect(h.output()).not.toMatch(/Postgres/i);
  });
});
