import { describe, expect, it } from "vitest";
import { toRunEvent } from "../../agent/lib/dark-factory/run-history";

/**
 * #378 — the revision cap needs a durable count, so a plan revision is recorded as its own event.
 *
 * The run re-parks around a revision, so the run is `blocked` at the moment the event is appended. The
 * status rule is asserted rather than assumed: an event type with no constraint would let a revision be
 * recorded against a run that is happily coding, which is exactly the state a revision must never reach.
 */
describe("run.plan_revised", () => {
  it("accepts a plan revision recorded while the run is blocked", () => {
    const event = toRunEvent({
      eventId: "evt-plan-revised-1",
      runId: "run-1",
      type: "run.plan_revised" as never,
      stage: "worker",
      occurredAt: "2026-10-17T12:00:00.000Z",
      status: "blocked",
    });
    expect(event.type).toBe("run.plan_revised");
    expect(event.status).toBe("blocked");
  });

  it("refuses a plan revision recorded while the run is not blocked", () => {
    expect(() =>
      toRunEvent({
        eventId: "evt-plan-revised-2",
        runId: "run-1",
        type: "run.plan_revised" as never,
        stage: "worker",
        occurredAt: "2026-10-17T12:00:00.000Z",
        status: "running",
      }),
    ).toThrow(/blocked/i);
  });
});
