import { describe, expect, it } from "vitest";
import {
  MARKER_LINE_SOURCE,
  parseExecutedTestCases,
  testCaseEvidenceSources,
} from "../../agent/lib/dark-factory/test-case-evidence";

/**
 * #764 — the Definition of Done certifies a criterion against a NAMED test case, so it needs evidence that the case
 * actually ran. Today nothing captures that: the coding gate returns a boolean, so the runner records a passing
 * result for every criterion the plan mapped (`scripts/dark-factory-runner.ts:2556`). That is an assumption
 * presented as evidence, and it is why a `done` verdict can certify criteria whose tests were never written.
 *
 * This is the seam that supplies the missing evidence. It is deliberately not a runner-specific parser: the Factory
 * is provider- and repo-agnostic by default, and a parser keyed to one runner's output format would put that runner
 * into the invariant. The first source is described by the SHAPE it recognises (a per-case marker line), not by the
 * tool that emits it, so any runner with that shape is covered and a differently-shaped runner is added alongside
 * rather than rewriting the caller.
 *
 * The load-bearing property is the negative one: when the output cannot be read, the answer is NO CASES - never a
 * pass. A parse that invents a case would reintroduce exactly the defect this exists to remove.
 */
describe("#764 - what test cases did a run actually execute?", () => {
  it("reports a case that ran and passed", () => {
    const cases = parseExecutedTestCases("  ✓ renders the Dark Factory credit in italics\n");

    expect(cases).toEqual([{ name: "renders the Dark Factory credit in italics", passed: true }]);
  });

  it("reports a case that ran and FAILED, as a failure rather than an absence", () => {
    // A failing case is evidence too: it must be reported, or a red run would look like an unreadable one.
    const cases = parseExecutedTestCases("  × renders the Dark Factory credit in italics\n");

    expect(cases).toEqual([{ name: "renders the Dark Factory credit in italics", passed: false }]);
  });

  it("reads the alternate fail marker as a failure", () => {
    const cases = parseExecutedTestCases("  ✗ adds nothing else to the footer\n");

    expect(cases).toEqual([{ name: "adds nothing else to the footer", passed: false }]);
  });

  it("reads every case in a multi-case run, not just the first", () => {
    const output = [
      "  ✓ renders the exact credit copy in the footer",
      "  ✓ renders the credit copy in italics",
      "  × renders the credit next to the existing copyright sentence",
    ].join("\n");

    const cases = parseExecutedTestCases(output);

    expect(cases.map((c) => c.name)).toEqual([
      "renders the exact credit copy in the footer",
      "renders the credit copy in italics",
      "renders the credit next to the existing copyright sentence",
    ]);
    expect(cases.map((c) => c.passed)).toEqual([true, true, false]);
  });

  it("CONTROL: a summary line is not a case", () => {
    // The summary is the line a naive parser turns into a phantom test case - which would then certify an AC.
    const cases = parseExecutedTestCases(" Test Files  1 passed (1)\n      Tests  3 passed (3)\n");

    expect(cases).toEqual([]);
  });

  it("returns NO cases for output it cannot read, so absence can never be read as a pass", () => {
    // The load-bearing negative: unreadable output is no evidence, and the caller must fail closed on it.
    const cases = parseExecutedTestCases("something went wrong but nothing per-case was printed");

    expect(cases).toEqual([]);
  });

  it("is a list of sources, so a differently-shaped runner is added rather than the caller rewritten", () => {
    const sources = testCaseEvidenceSources();

    expect(sources.length).toBeGreaterThan(0);
    expect(sources).toContain(MARKER_LINE_SOURCE);
    // A source names itself, so a run's log can say which one read its output.
    expect(MARKER_LINE_SOURCE.name).toMatch(/\S/);
  });

  it("reports which source read the output, so the evidence is attributable", () => {
    expect(MARKER_LINE_SOURCE.recognises("  ✓ one case\n")).toBe(true);
    expect(MARKER_LINE_SOURCE.recognises("no cases here")).toBe(false);
  });
});
