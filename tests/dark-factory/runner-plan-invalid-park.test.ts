import { describe, expect, it } from "vitest";
import {
  parkQuestionFor,
  parksForHumanDecision,
  parksForUnjustifiableTarget,
} from "../../scripts/dark-factory-runner";
import {
  PLAN_INVALID_QUESTION,
  TARGET_UNRESOLVED_QUESTION,
} from "../../agent/lib/dark-factory/plan-approval";

/**
 * #381 R2 Task 8 - which reasons park, and which question each one asks.
 *
 * A park must never ask a human to approve a plan that does not exist, and it must not ask about a target
 * when the problem was the plan's shape. The old predicate keeps its exact meaning: the two target reasons.
 */
describe("#381 R2 Task 8 - parking on an invalid plan", () => {
  it("parks on an invalid plan, and still parks on both target reasons", () => {
    expect(parksForHumanDecision("plan-invalid")).toBe(true);
    expect(parksForHumanDecision("unresolved-surface")).toBe(true);
    expect(parksForHumanDecision("refused-target")).toBe(true);
  });

  it("does NOT park on a fault a human cannot answer", () => {
    expect(parksForHumanDecision(undefined)).toBe(false);
    expect(parksForHumanDecision("the model timed out")).toBe(false);
  });

  it("keeps parksForUnjustifiableTarget meaning exactly what it meant before", () => {
    expect(parksForUnjustifiableTarget("plan-invalid")).toBe(false);
    expect(parksForUnjustifiableTarget("refused-target")).toBe(true);
  });

  it("asks about the validation errors rather than approval, for an invalid plan", () => {
    expect(parkQuestionFor("plan-invalid")).toBe(PLAN_INVALID_QUESTION);
    expect(PLAN_INVALID_QUESTION).toMatch(/validation|validat/i);
    // It must NOT be the approval question: there is no plan to approve.
    expect(PLAN_INVALID_QUESTION).not.toBe(TARGET_UNRESOLVED_QUESTION);
  });

  it("asks which surface was meant, for an unjustifiable target", () => {
    expect(parkQuestionFor("refused-target")).toBe(TARGET_UNRESOLVED_QUESTION);
    expect(parkQuestionFor("unresolved-surface")).toBe(TARGET_UNRESOLVED_QUESTION);
  });
});
