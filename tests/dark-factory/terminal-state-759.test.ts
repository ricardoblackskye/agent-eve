import { describe, expect, it } from "vitest";

import { OUTCOME_LABELS, TRIGGER_LABELS } from "../../agent/lib/dark-factory/trigger";

/**
 * #759 task 3 - the guard the screenshot is actually about.
 *
 * `OUTCOME_LABELS` is "what a fresh start CLEARS". It contains `done`, which is why a dispatched re-run
 * removed `df:done` from a finished ticket and the page read "added df:running and removed df:done".
 *
 * A delivered state is terminal, so clearing it is wrong on every path - and the CLI path is where it
 * actually happened, because `RETRIGGER_REFUSED_LABELS` guards the LABEL path only.
 *
 * The third case is the control: `df:blocked` is NOT terminal - a blocked ticket is re-triggerable, which
 * is the point of that outcome - so its stale verdict must still be cleared. A fix that empties the set
 * fails here.
 *
 * Reported honestly: case 1 is the defect and is RED. Case 2 is a FORWARD GUARD - it passes today
 * because the label is new, and exists so a later edit cannot quietly add it. Case 3 is the control.
 */
describe("a delivered state survives a fresh dispatch (#759 task 3)", () => {
  it("does not clear df:done - the work is finished", () => {
    expect(OUTCOME_LABELS).not.toContain(TRIGGER_LABELS.done);
  });

  it("does not clear the sign-off instruction", () => {
    expect(TRIGGER_LABELS.signoff).toBe("awaiting-signoff");
    expect(OUTCOME_LABELS).not.toContain(TRIGGER_LABELS.signoff);
  });

  // The control: a blocked attempt is re-triggerable, so clearing its verdict stays correct.
  it("still clears a previous attempt s blocked verdict", () => {
    expect(OUTCOME_LABELS).toContain(TRIGGER_LABELS.blocked);
  });
});
