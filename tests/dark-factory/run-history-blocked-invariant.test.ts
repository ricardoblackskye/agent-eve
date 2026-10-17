import { describe, expect, it } from "vitest";
import { toRunEvent } from "../../agent/lib/dark-factory/run-history";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

/**
 * The invariant the first #378 revision design collided with, kept as a test because it is WHY the design
 * is what it is.
 *
 * A parked run may receive exactly two things: `run.resumed` (a human answered) or `run.terminal` (it
 * ended). Nothing else. That is what makes the park meaningful — a parked run must not accumulate work
 * events while it waits, or "blocked" would describe a run that is quietly still doing things.
 *
 * The first design recorded a dedicated `run.plan_revised` event while the run was blocked, and a LIVE
 * end-to-end run refused it:
 *   Run record requires "type" to resume a blocked run before further work events (received "run.plan_revised")
 * The fix was NOT to widen this rule; it was to record the reply as the resume it actually is.
 *
 * The rule lives in `applyRunEvent`, which enforces the transition — NOT in `toRunEvent`, which only
 * normalises a single event. So these cases drive the REAL store, whose `appendEvent` applies the event
 * to the run. A stub that enforces no transitions is exactly why the recorded suite could not see this.
 */
describe("a blocked run accepts only a resume or a terminal event", () => {
  async function blockedRun() {
    const history = new SqliteRunHistoryStore(":memory:", () => "run-invariant");
    const accepted = await history.acceptDelivery({
      deliveryId: "invariant",
      repo: "ricardoblackskye/agent-eve",
      issue: 378,
      receivedAt: "2026-10-17T12:00:00.000Z",
    });
    const runId = accepted.value?.runId;
    if (!runId) throw new Error("fixture did not return a run ID");
    await history.appendEvent({
      eventId: "invariant-question",
      runId,
      type: "worker.question",
      stage: "worker",
      occurredAt: "2026-10-17T12:00:01.000Z",
      status: "blocked",
    });
    return { history, runId };
  }

  it("refuses a work event while the run is blocked", async () => {
    const { history, runId } = await blockedRun();
    try {
      const refused = await history.appendEvent({
        eventId: "invariant-work",
        runId,
        type: "worker.progress",
        stage: "worker",
        occurredAt: "2026-10-17T12:00:02.000Z",
        status: "blocked",
      });
      expect(refused.ok).toBe(false);
      expect(String(refused.error)).toMatch(/resume a blocked run/i);
    } finally {
      await history.close();
    }
  });

  it("accepts run.resumed, which is how a human's reply is recorded", async () => {
    const { history, runId } = await blockedRun();
    try {
      const resumed = await history.appendEvent({
        eventId: "invariant-resume",
        runId,
        type: "run.resumed",
        stage: "dispatch",
        occurredAt: "2026-10-17T12:00:03.000Z",
        status: "running",
      });
      expect(resumed.ok).toBe(true);
      expect(resumed.value?.status).toBe("running");
    } finally {
      await history.close();
    }
  });

  it("accepts run.terminal, so a parked run can always be ended", async () => {
    const { history, runId } = await blockedRun();
    try {
      const terminal = await history.appendEvent({
        eventId: "invariant-terminal",
        runId,
        type: "run.terminal",
        stage: "terminal",
        occurredAt: "2026-10-17T12:00:04.000Z",
        status: "failed",
      });
      expect(terminal.ok).toBe(true);
      expect(terminal.value?.status).toBe("failed");
    } finally {
      await history.close();
    }
  });

  it("rejects an event type outside the closed union", () => {
    // Why the abandoned design was a schema change rather than a new string.
    expect(() =>
      toRunEvent({
        runId: "run-1",
        eventId: "evt-ghost",
        type: "run.plan_revised" as never,
        stage: "worker",
        occurredAt: "2026-10-17T12:00:00.000Z",
        status: "blocked",
      }),
    ).toThrow(/to be one of/i);
  });
});
