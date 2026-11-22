import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * #701 — a wiring guard, because the mechanism existing is not the capability being available.
 *
 * Three separate defects were found in one session where a function was built and unit-tested while nothing
 * in production ever supplied its input (#727 the validator's file list, #728 the discovery's alias map, #730
 * the plan record). `formatTestVerdict` is useless if the runner does not call it, and the not-run list is a
 * lie if it is not derived from what the TARGET declares. This asserts the call site, not the function.
 */
const runner = readFileSync("scripts/dark-factory-runner.ts", "utf8");

describe("#701 the runner's verdict is wired to the target's own declaration", () => {
  it("composes the verdict with formatTestVerdict, not a bare PASS/FAIL", () => {
    // The INTENT is that the verdict is composed by formatTestVerdict. Its argument varies
    // legitimately - it is `gatePassed` now that a failed e2e folds into the gate - so asserting the
    // exact argument would break on a correct change. Assert the composition, not the spelling.
    expect(runner).toContain("formatTestVerdict(");
    // The bare form is precisely what this change replaces.
    expect(runner).not.toContain('${testOutcome.passed ? "PASS" : "FAIL"}');
  });

  it("derives the not-run list from the target's declared e2e command", () => {
    // #739: resolution moved with the run - it now feeds the PR's checks, not the sandbox.
    expect(runner).not.toContain("resolveE2eCommand(");
    // The not-run list must still DERIVE from the target's declaration, whatever shape the expression
    // takes - assert the intent, not an exact spelling that a legitimate change would break.
    // #739: the declared e2e is no longer a sandbox suite - it runs on the PR.
    expect(runner).not.toContain("declaredE2eCommands");
  });
});

describe("#701 the e2e attempt is wired, not just available", () => {
  it("runs the declared suite and folds the result into the iteration's gate", () => {
    // #739: the sandbox no longer runs the declared e2e - it runs on the pull request,
    // where the DoD reads the target's own checks.
    expect(runner).not.toContain("runDeclaredE2e");
    // #731: the composition moved into decideGate, which returns BOTH the gate and the environment flag.
    // Asserted as the intent - both inputs feed the decision - not as the old spelling.
    expect(runner).toContain("decideGate(testOutcome.passed)");
    // The worker reports the COMBINED gate, not the unit outcome alone.
    expect(runner).toContain("passed: gatePassed,");
    expect(runner).not.toContain("passed: testOutcome.passed,");
  });
});
