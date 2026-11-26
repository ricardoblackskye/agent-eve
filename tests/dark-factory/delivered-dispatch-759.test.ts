import { describe, expect, it } from "vitest";

import { applyStartLifecycle } from "../../agent/lib/dark-factory/run-finalizer";

const REPO = "ricardoblackskye/WebFeedPOC";

function labelWriter() {
  const calls: string[] = [];
  const writer = {
    async add(_repo: string, _issue: number, label: string) {
      calls.push(`add:${label}`);
      return { ok: true };
    },
    async remove(_repo: string, _issue: number, label: string) {
      calls.push(`remove:${label}`);
      return { ok: true };
    },
  };
  return { writer, calls };
}

/**
 * #759 task 3, second half - the DISPATCH side.
 *
 * Stopping the clear (the first half) is not enough on its own: a dispatch that still adds df:running to a
 * ticket keeping df:done advertises the contradictory pair the file s own documentation removed for
 * df:failed. The pairing must be prevented where the run STARTS, which is the path that produced the
 * original screenshot - RETRIGGER_REFUSED_LABELS guards only the label path.
 *
 * The second case is the control that matters most: df:failed describes a finished ATTEMPT a human may
 * retry, so refusing on it would break every legitimate re-run - including the one #744 exists to support.
 */
describe("a dispatch against a delivered ticket is refused (#759)", () => {
  it("refuses, and neither clears the delivered label nor marks the ticket in flight", async () => {
    const { writer, calls } = labelWriter();

    const outcome = await applyStartLifecycle(
      { labelWriter: writer } as never,
      { repo: REPO, issue: 260, existingLabels: ["df:done"] } as never,
    );

    expect(outcome.refused).toMatch(/delivered|df:done/);
    expect(calls).not.toContain("remove:df:done");
    expect(calls).not.toContain("add:df:running");
    expect(calls.length).toBe(0);
  });

  // The control: a retryable finish is NOT a delivered one.
  it("still starts normally on a ticket whose last attempt failed", async () => {
    const { writer, calls } = labelWriter();

    const outcome = await applyStartLifecycle(
      { labelWriter: writer } as never,
      { repo: REPO, issue: 672, existingLabels: ["df:failed"] } as never,
    );

    expect(outcome.refused).toBeUndefined();
    expect(calls).toContain("remove:df:failed");
    expect(calls).toContain("add:df:running");
  });

  it("behaves as before when the caller supplies no labels", async () => {
    const { writer, calls } = labelWriter();

    const outcome = await applyStartLifecycle(
      { labelWriter: writer } as never,
      { repo: REPO, issue: 999 } as never,
    );

    expect(outcome.refused).toBeUndefined();
    expect(calls).toContain("add:df:running");
  });
});
