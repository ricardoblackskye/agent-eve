/**
 * #716 - the run's own counters must reach the summary.
 *
 * Re-pointed by decision (issue comment, option C): #716 takes the SUPPLY - the runner hands the Definition of
 * Done the counters the coding loop already knows - and the REPRESENTATION of "unmeasured" is deferred to #768.
 *
 * Two earlier framings were wrong, and both are worth recording rather than quietly replacing:
 *
 *  - the first version asserted an unmeasured counter comes back `undefined`. That is #768's behaviour, and under
 *    option C it can NEVER pass on this branch - leaving it would create the pressure to make a test pass by
 *    implementing the change we had just deferred. That is the dishonest GREEN, avoided here;
 *  - a source-grep guard on its own is VACUOUS - it has passed in this repository while the wiring was absent.
 *    So the assertion below is BOUNDED to its call site, and paired with a case proving the slice is not empty.
 *
 * Verified before writing this, rather than assumed: `runMetrics` appears NOWHERE in
 * `scripts/dark-factory-runner.ts`, and the STEP 7 call passes `{ runId, repo, issue, head, plan, title, body,
 * testResults }` with no metrics - the omission that leaves every summary reporting a fabricated `0`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(resolve(process.cwd(), "scripts/dark-factory-runner.ts"), "utf8");

/**
 * The STEP 7 Definition-of-Done call, sliced between two markers that each occur once. Bounding matters: an
 * unbounded `toContain` over a 2,800-line file kept passing whether or not the wiring existed.
 */
function step7Block(source: string): string {
  const start = source.indexOf("[STEP 7] Executing Hardened Definition of DONE");
  const end = source.indexOf("DARK FACTORY RUNNER: EXECUTION COMPLETED SUCCESSFULLY", start);
  return start === -1 || end === -1 ? "" : source.slice(start, end);
}

describe("#716 the runner supplies the counters the summary records", () => {
  it("the slice is the call site, proven by a token only this call passes (so the guard is not vacuous)", () => {
    const block = step7Block(SOURCE);

    expect(block.length).toBeGreaterThan(0);
    // `testResults` is passed only here, so finding it proves the slice really is the STEP 7 call.
    expect(block).toContain("testResults");
  });

  it("passes runMetrics to the Definition of Done, so the summary records a measurement", () => {
    const block = step7Block(SOURCE);

    // Without this the DoD has nothing to spread and the write paths fall back to a fabricated zero - which is how
    // a run whose log reads "Coding Iteration 2/10" is recorded as having iterated zero times.
    expect(block).toContain("runMetrics");
  });
});
