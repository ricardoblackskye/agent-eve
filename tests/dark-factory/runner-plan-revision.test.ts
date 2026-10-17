import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parksForHumanApproval } from "../../scripts/dark-factory-runner";

/**
 * #378 — the property that matters is "a revision never reaches the coding phase". That is pinned here
 * as a real behaviour on the shared decision, plus a source guard that the runner actually uses it
 * rather than an inline `if`. The runner is imported safely: its `main()` is behind an `isDirectRun`
 * guard.
 */
describe("parksForHumanApproval (#378)", () => {
  it("parks a fresh run", () => {
    expect(parksForHumanApproval({ resuming: false, revision: false })).toBe(true);
  });

  it("does NOT park an approval resume, so it proceeds to code", () => {
    expect(parksForHumanApproval({ resuming: true, revision: false })).toBe(false);
  });

  it("PARKS a revision resume, so the coding phase is unreachable", () => {
    expect(parksForHumanApproval({ resuming: true, revision: true })).toBe(true);
  });
});

describe("the runner wires the revision branch (#378)", () => {
  const source = readFileSync("scripts/dark-factory-runner.ts", "utf8");

  it("classifies the reply on a resume", () => {
    expect(source).toContain("classifyPlanResponse(");
  });

  it("gates parking on the shared decision, not on !isResume", () => {
    expect(source).toContain(
      "parksForHumanApproval({ resuming: isResume, revision: isRevision })",
    );
    expect(source).not.toContain("if (!isResume) {");
  });

  it("amends from the frozen plan plus the feedback", () => {
    expect(source).toContain("architectAgent.amendPlan(");
    expect(source).toContain("currentPlan: executionPlan");
  });

  it("refuses past the revision cap", () => {
    expect(source).toContain("isPlanRevisionCapReached(");
  });

  it("records the round durably", () => {
    expect(source).toContain("recordPlanRevision(");
  });

  it("RESOLVES the answer from a file, and refuses when it cannot be read", () => {
    expect(source).toContain("resolveRunnerAnswer(");
    expect(source).toContain("if (!answerResult.ok) {");
  });

  it("keeps the amendment BEFORE the coding phase call", () => {
    expect(source.indexOf("architectAgent.amendPlan(")).toBeLessThan(
      source.indexOf("await runCodingPhase("),
    );
  });
});
