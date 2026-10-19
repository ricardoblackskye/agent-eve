import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parksForUnjustifiableTarget } from "../../scripts/dark-factory-runner";
import {
  PLAN_APPROVAL_QUESTION,
  TARGET_UNRESOLVED_QUESTION,
} from "../../agent/lib/dark-factory/plan-approval";

/**
 * #381 R2 AC4 - an unjustifiable target PARKS the run; it does not fail it.
 *
 * The distinction is the whole point of AC4. A failed run ends the work, while a parked run is resumable and
 * the human's answer may simply be "the shell is right, go ahead" - which a terminal failure would discard.
 *
 * Follows the #378 precedent: a real behaviour on a shared decision, plus a source guard that the runner uses
 * it rather than an inline condition. Importing the runner is safe - its `main()` sits behind `isDirectRun`.
 */
describe("parksForUnjustifiableTarget (#381 R2)", () => {
  it("PARKS when the surface could not be resolved", () => {
    expect(parksForUnjustifiableTarget("unresolved-surface")).toBe(true);
  });

  it("PARKS when a refused target survived the repair rounds", () => {
    expect(parksForUnjustifiableTarget("refused-target")).toBe(true);
  });

  it("does NOT park an ordinary failure, which still fails terminally", () => {
    // A parse failure or a provider error is not a question for a human; parking those would turn every
    // transient fault into a ticket waiting on someone.
    expect(parksForUnjustifiableTarget(undefined)).toBe(false);
    expect(parksForUnjustifiableTarget("unparseable-output")).toBe(false);
    expect(parksForUnjustifiableTarget("")).toBe(false);
  });
});

describe("the target park asks its own question (#381 R2)", () => {
  it("is not the approval question", () => {
    // There is no plan to approve, so reusing the approval text would ask a human to approve nothing.
    expect(TARGET_UNRESOLVED_QUESTION).not.toBe(PLAN_APPROVAL_QUESTION);
    expect(TARGET_UNRESOLVED_QUESTION).toMatch(/surface|page|route/i);
  });
});

describe("the runner wires the target park (#381 R2)", () => {
  const source = readFileSync("scripts/dark-factory-runner.ts", "utf8");

  it("decides through the shared function rather than an inline condition", () => {
    // Assert the CALL, not the name: the runner also DEFINES this function, so a bare name match would pass
    // on the definition alone and prove nothing about the wiring.
    expect(source).toMatch(
      /parksForUnjustifiableTarget\(\s*planResult\.reason\s*\)/,
    );
  });

  it("parks with the target question", () => {
    expect(source).toContain("TARGET_UNRESOLVED_QUESTION");
  });
});
