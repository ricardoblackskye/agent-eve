import { describe, expect, it } from "vitest";
import { recordPassingTestResults } from "../../scripts/dark-factory-runner";

/**
 * #503 AC4 — the coding-phase test-result capture must not dereference a missing
 * `acceptanceCriteriaMap`. The field is typed as required but a deserialized plan may omit it
 * (the architect returned one without it at STEP 3.5), so the old inline `for (const ac of
 * ctx.plan.acceptanceCriteriaMap)` threw. The recording layer tolerates the omission.
 */
describe("recordPassingTestResults (#503 AC4)", () => {
  it("does not throw and records nothing when the plan has no acceptanceCriteriaMap", () => {
    const captured: { testFile: string; testCaseName: string; passed: boolean }[] = [];
    expect(() =>
      recordPassingTestResults({ acceptanceCriteriaMap: undefined }, captured),
    ).not.toThrow();
    expect(captured).toEqual([]);
  });

  it("tolerates a null map (the same runtime shape as a missing one)", () => {
    const captured: { testFile: string; testCaseName: string; passed: boolean }[] = [];
    expect(() =>
      recordPassingTestResults({ acceptanceCriteriaMap: null }, captured),
    ).not.toThrow();
    expect(captured).toEqual([]);
  });

  it("records a passing result for each mapped AC when the map is present", () => {
    const captured: { testFile: string; testCaseName: string; passed: boolean }[] = [];
    recordPassingTestResults(
      {
        acceptanceCriteriaMap: [
          { testFile: "tests/a.test.ts", testCaseName: "a passes" },
          { testFile: "tests/b.test.ts", testCaseName: "b passes" },
        ],
      },
      captured,
    );
    expect(captured).toEqual([
      { testFile: "tests/a.test.ts", testCaseName: "a passes", passed: true },
      { testFile: "tests/b.test.ts", testCaseName: "b passes", passed: true },
    ]);
  });
});
