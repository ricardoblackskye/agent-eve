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
    expect(runner).toContain("formatTestVerdict(testOutcome.passed");
    // The bare form is precisely what this change replaces.
    expect(runner).not.toContain('${testOutcome.passed ? "PASS" : "FAIL"}');
  });

  it("derives the not-run list from the target's declared e2e command", () => {
    expect(runner).toContain("resolveE2eCommand(");
    expect(runner).toMatch(/notRun:\s*declaredE2eCommands/);
  });
});
