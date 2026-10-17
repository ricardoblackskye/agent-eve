import { describe, expect, it } from "vitest";
import {
  classifyPlanResponse,
  resolveMaxPlanRevisions,
} from "../../agent/lib/dark-factory/plan-response";

/**
 * #378 — approval is OPT-IN. Anything that is not an explicit approval is revision feedback, and the
 * run must never code without explicit approval. These cases pin BOTH halves of that rule: the wording
 * that counts, and the wording that must NOT.
 */
describe("classifyPlanResponse", () => {
  it("treats an explicit approval as approval", () => {
    expect(classifyPlanResponse("Approved").kind).toBe("approval");
  });

  it("treats a bare approve as approval", () => {
    expect(classifyPlanResponse("approve").kind).toBe("approval");
  });

  it("treats approval wrapped in markdown emphasis as approval", () => {
    expect(classifyPlanResponse("**Approved**").kind).toBe("approval");
  });

  it("tolerates surrounding whitespace and trailing punctuation", () => {
    expect(classifyPlanResponse("  Approved!  ").kind).toBe("approval");
  });

  it("treats approval followed by a request as a revision", () => {
    expect(classifyPlanResponse("Approved, but also update the header").kind).toBe("revision");
  });

  it("treats a plan-change request as a revision", () => {
    expect(
      classifyPlanResponse("The text should be on the main page, not a product detail page.").kind,
    ).toBe("revision");
  });

  it("treats an unrelated comment as a revision", () => {
    expect(classifyPlanResponse("thanks, what is the ETA?").kind).toBe("revision");
  });

  it("treats an empty comment as a revision", () => {
    expect(classifyPlanResponse("").kind).toBe("revision");
  });

  it("treats a whitespace-only comment as a revision", () => {
    expect(classifyPlanResponse("   \n  ").kind).toBe("revision");
  });

  it("does not approve on the word approved inside a negation", () => {
    expect(classifyPlanResponse("not approved - change the target file").kind).toBe("revision");
  });

  it("carries a reason on both outcomes", () => {
    expect(classifyPlanResponse("Approved").reason.length).toBeGreaterThan(0);
    expect(classifyPlanResponse("change the target file").reason.length).toBeGreaterThan(0);
  });
});

/**
 * The cap exists because every non-approval reply is a revision: without a bound, an unrelated comment
 * or a chatty thread could send the architect round the loop indefinitely.
 */
describe("resolveMaxPlanRevisions", () => {
  it("defaults the revision cap to 5", () => {
    expect(resolveMaxPlanRevisions({})).toBe(5);
  });

  it("reads the revision cap from the environment", () => {
    expect(resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "2" })).toBe(2);
  });

  it("treats a blank cap as unset and falls through to the default", () => {
    expect(resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "   " })).toBe(5);
  });

  it("refuses a malformed cap rather than defaulting silently", () => {
    expect(resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "2" })).toBe(2);
    expect(() => resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "abc" })).toThrow();
  });

  it("refuses a non-integer cap", () => {
    expect(resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "2" })).toBe(2);
    expect(() => resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "3.14" })).toThrow();
  });

  it("refuses a non-positive cap", () => {
    expect(resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "2" })).toBe(2);
    expect(() => resolveMaxPlanRevisions({ DF_MAX_PLAN_REVISIONS: "0" })).toThrow();
  });
});
