import { describe, expect, it } from "vitest";
import { formatTestVerdict } from "../../agent/lib/dark-factory/developer-agent";

/**
 * #701 — the loop's gate is not the target's gate.
 *
 * The coding loop verifies a change with the target's UNIT tests and then reports `Test result: PASS`. That
 * reads as "this work is verified" while the target's e2e suite has never been run - which is how a PR is
 * opened green-by-the-loop and red in CI.
 *
 * The cheapest, honest half of the fix is to make the verdict say what it covered. This is the part that is
 * correct on its own, whatever happens to the attempt that follows it.
 */
describe("#701 the loop's verdict names its suites", () => {
  it("names the suites it ran, and the ones it did not", () => {
    expect(formatTestVerdict(true, { ran: ["unit"], notRun: ["e2e"] })).toBe(
      "PASS (unit) - NOT run: e2e",
    );
  });

  it("says nothing about not-run when the target declares no e2e", () => {
    expect(formatTestVerdict(true, { ran: ["unit"], notRun: [] })).toBe("PASS (unit)");
  });

  it("CONTROL: a failure still reads as a failure", () => {
    // The verdict must not quietly rewrite what a failure says - only add to what a pass admits.
    const verdict = formatTestVerdict(false, { ran: ["unit"], notRun: ["e2e"] });
    expect(verdict.startsWith("FAIL")).toBe(true);
    expect(verdict).toContain("NOT run: e2e");
  });
});
