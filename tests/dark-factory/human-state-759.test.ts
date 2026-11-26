import { describe, expect, it } from "vitest";

import { selectHumanStateLabel } from "../../agent/lib/dark-factory/trigger";

/**
 * #759. A delivered issue must ask for SIGN-OFF, and a parked plan must keep asking for APPROVAL - two
 * different requests that `needs-answer` collapsed into one.
 *
 * The second case is the control that keeps this honest: a blanket rename of the label everywhere would
 * satisfy the first and fail this one. The fourth pins the vocabulary rule the file already states - the
 * instruction label is not lifecycle state, so it must not join the `df:` family.
 */
describe("the label that instructs a human (#759)", () => {
  it("asks for sign-off when the work is delivered and its pull request is open", () => {
    const label = selectHumanStateLabel({
      planParked: false,
      dodPassed: true,
      pullRequestOpen: true,
    });
    expect(label).toBe("awaiting-signoff");
  });

  // The control: a parked plan still asks for approval to START. A blanket rename fails here.
  it("still asks the plan question when a plan is parked", () => {
    const label = selectHumanStateLabel({
      planParked: true,
      dodPassed: false,
      pullRequestOpen: false,
    });
    expect(label).toBe("needs-answer");
  });

  it("asks nothing of a human when neither state holds", () => {
    const label = selectHumanStateLabel({
      planParked: false,
      dodPassed: false,
      pullRequestOpen: false,
    });
    expect(label).toBeNull();
  });

  it("asks nothing when the Definition of Done passed but there is no pull request to sign off", () => {
    const label = selectHumanStateLabel({
      planParked: false,
      dodPassed: true,
      pullRequestOpen: false,
    });
    expect(label).not.toBe("awaiting-signoff");
  });

  it("keeps the instruction label outside the lifecycle family", () => {
    const label = selectHumanStateLabel({
      planParked: false,
      dodPassed: true,
      pullRequestOpen: true,
    });
    expect(label?.startsWith("df:")).toBe(false);
  });
});
