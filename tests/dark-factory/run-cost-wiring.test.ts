import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A source guard on the runner's wiring (#531), the repo's convention for a composition root: the
 * behaviour lives behind a seam that is unit-tested, and what needs pinning here is that the runner
 * actually calls it, at the end, for this run.
 */
const RUNNER = readFileSync(resolve(process.cwd(), "scripts/dark-factory-runner.ts"), "utf8");

describe("the runner records the run's cost (#531)", () => {
  it("calls the recorder, imported from the module that owns the definition", () => {
    expect(RUNNER).toContain("await recordRunActualCost(");
    expect(RUNNER).toContain('from "../agent/lib/dark-factory/run-cost-recorder"');
  });

  it("passes a recorder built from the run history the active run already holds", () => {
    expect(RUNNER).toMatch(/recordRunActualCost\(/);
    expect(RUNNER).toMatch(/runHistory/);
  });

  it("calls it from BOTH entry paths — a run that aborts spent money too", () => {
    const calls = RUNNER.match(/recordRunCostForRun\(activeRun/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it("treats the write as best-effort, so a cost can never fail a run", () => {
    // `await` disambiguates the CALL from the import, which appears first in the file.
    const index = RUNNER.indexOf("await recordRunActualCost(");
    // Asserted first: with the call absent, `indexOf` returns -1 and the slice below would be the
    // whole file, so a stray `catch` anywhere would satisfy this case vacuously.
    expect(index).toBeGreaterThan(-1);
    // The call spans several lines, so the window must clear its arguments before the catch.
    const call = RUNNER.slice(index, index + 1500);
    expect(call).toMatch(/catch\s*\(/);
  });
});
