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
  it("calls the recorder", () => {
    expect(RUNNER).toContain("recordRunActualCost");
  });

  it("passes a recorder built from the run history it already holds", () => {
    expect(RUNNER).toMatch(/recordRunActualCost\(/);
    expect(RUNNER).toMatch(/runHistory/);
  });

  it("treats the write as best-effort, so a cost can never fail a run", () => {
    const index = RUNNER.indexOf("recordRunActualCost(");
    // Asserted first: with the call absent, `indexOf` returns -1 and the slice below would be the
    // whole file, so a stray `catch` anywhere would satisfy this case vacuously.
    expect(index).toBeGreaterThan(-1);
    const call = RUNNER.slice(Math.max(0, index - 600), index + 300);
    expect(call).toMatch(/catch/);
  });
});
