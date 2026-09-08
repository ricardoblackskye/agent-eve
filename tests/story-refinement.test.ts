import { describe, it, expect } from "vitest";
import { detectGaps, type DraftStory } from "../agent/lib/story-refinement";

const draft: DraftStory = {
  intent: "A user can reset their password from the login screen.",
  acceptanceCriteria: [
    {
      given: "a registered email",
      when: "the user submits reset",
      then: "exactly 1 email is sent",
    },
  ],
  examples: [{ input: "user@example.com", output: "reset email delivered" }],
  constraints: ["MUST NOT reveal whether an account exists"],
};

describe("detectGaps", () => {
  it("returns no gaps for a specific draft", () => {
    expect(detectGaps(draft)).toEqual([]);
  });

  it("flags a vague intent (under 40 chars)", () => {
    expect(
      detectGaps({ ...draft, intent: "make login better" }).map((g) => g.field),
    ).toContain("intent");
  });

  it("flags an unmeasurable acceptance criterion", () => {
    const g = detectGaps({
      ...draft,
      acceptanceCriteria: [{ given: "x", when: "y", then: "it works well" }],
    });
    expect(g.map((x) => x.field)).toContain("acceptanceCriteria");
  });

  it("flags a missing example", () => {
    expect(
      detectGaps({ ...draft, examples: [] }).map((g) => g.field),
    ).toContain("examples");
  });

  it("returns a question for every gap", () => {
    const gaps = detectGaps({ ...draft, examples: [] });
    expect(gaps[0].question.length).toBeGreaterThan(10);
  });

  it("reports multiple independent gaps at once", () => {
    const gaps = detectGaps({ ...draft, examples: [], intent: "tweak it" });
    expect(gaps.length).toBeGreaterThanOrEqual(2);
  });
});
