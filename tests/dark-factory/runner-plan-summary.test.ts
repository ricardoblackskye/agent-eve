/**
 * #501 - display never asserts on plan shape.
 *
 * A real local run died here. The architect is built with `maxPlanRetries: 2`, and `planStory` returns the
 * LAST attempt: attempt 2 carried `acceptanceCriteriaMap`, attempt 3 did not, so a self-correction cycle
 * replaced a plan that had the field with one that does not. The progress line that dereferenced it
 * aborted the run at STEP 3.5 - before the plan comment, before the ledger write, before the park.
 *
 * These cases pin that the summary reports what a plan has and never throws. They deliberately do NOT
 * pin what is accepted: refusing a plan that maps no acceptance criteria is issue #502, and this change
 * leaves that policy exactly where it was.
 */
import { describe, expect, it } from "vitest";

import { planSummaryLines } from "../../scripts/dark-factory-runner";

const valueFor = (lines: ReturnType<typeof planSummaryLines>, label: string) =>
  lines.find((entry) => entry.label === label)?.value;

const COMPLETE = {
  summary: "Add a bold sub-heading to the home page",
  targetFiles: [{ path: "src/pages/HomePage.jsx" }, { path: "src/pages/HomePage.test.jsx" }],
  acceptanceCriteriaMap: [{ acId: "AC1" }, { acId: "AC2" }, { acId: "AC3" }],
};

describe("#501 the plan summary reports what a plan has", () => {
  it("reports the mapping count for a complete plan", () => {
    expect(valueFor(planSummaryLines(COMPLETE), "AC Mappings Count")).toBe("3");
  });

  it("names every target file", () => {
    expect(valueFor(planSummaryLines(COMPLETE), "Target Files")).toBe(
      "src/pages/HomePage.jsx, src/pages/HomePage.test.jsx",
    );
  });

  it("renders the summary", () => {
    expect(valueFor(planSummaryLines(COMPLETE), "Plan Summary")).toBe(
      "Add a bold sub-heading to the home page",
    );
  });
});

describe("#501 the plan summary never throws on an incomplete plan", () => {
  it("reports an ABSENT acceptanceCriteriaMap instead of throwing - the #501 regression", () => {
    const { acceptanceCriteriaMap: _omitted, ...without } = COMPLETE;

    // The valid-value assertion comes FIRST, so this case cannot pass against a stub that throws
    // for everything.
    expect(valueFor(planSummaryLines(without), "Plan Summary")).toBe(
      "Add a bold sub-heading to the home page",
    );
    expect(() => planSummaryLines(without)).not.toThrow();
    expect(valueFor(planSummaryLines(without), "AC Mappings Count")).toBe("none supplied");
  });

  it("treats null and undefined identically to absent", () => {
    expect(
      valueFor(planSummaryLines({ ...COMPLETE, acceptanceCriteriaMap: null }), "AC Mappings Count"),
    ).toBe("none supplied");
    expect(
      valueFor(planSummaryLines({ ...COMPLETE, acceptanceCriteriaMap: undefined }), "AC Mappings Count"),
    ).toBe("none supplied");
  });

  it("distinguishes an EMPTY mapping list from an absent one", () => {
    expect(valueFor(planSummaryLines({ ...COMPLETE, acceptanceCriteriaMap: [] }), "AC Mappings Count")).toBe(
      "0",
    );
  });

  it("reports a non-array acceptanceCriteriaMap as absent rather than reporting a bogus count", () => {
    const malformed = { ...COMPLETE, acceptanceCriteriaMap: "AC1, AC2" as unknown as unknown[] };
    expect(() => planSummaryLines(malformed)).not.toThrow();
    expect(valueFor(planSummaryLines(malformed), "AC Mappings Count")).toBe("none supplied");
  });

  it("survives a missing targetFiles list", () => {
    expect(valueFor(planSummaryLines({ ...COMPLETE, targetFiles: undefined }), "Target Files")).toBe(
      "(none)",
    );
  });

  it("survives a missing summary", () => {
    expect(valueFor(planSummaryLines({ ...COMPLETE, summary: undefined }), "Plan Summary")).toBe("(none)");
  });

  it("survives a plan that is an empty object, reporting all three labels", () => {
    expect(() => planSummaryLines({})).not.toThrow();
    expect(planSummaryLines({}).map((entry) => entry.label)).toEqual([
      "Plan Summary",
      "Target Files",
      "AC Mappings Count",
    ]);
  });
});
