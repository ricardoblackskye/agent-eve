import { describe, expect, it, vi } from "vitest";
import {
  countPlanRevisions,
  isPlanRevisionCapReached,
  readPlanRevisionCount,
  recordPlanRevision,
} from "../../agent/lib/dark-factory/plan-revision-recorder";
import {
  SqliteRunHistoryStore,
  type RunHistoryStore,
} from "../../agent/lib/dark-factory/run-history-store";

/** A store stub that only implements the two methods this module uses. */
function historyStub(overrides: Partial<Record<"appendEvent" | "listRunEvents", unknown>>) {
  return {
    appendEvent: vi.fn().mockResolvedValue({ ok: true, mode: "live", providerId: "stub" }),
    listRunEvents: vi.fn().mockResolvedValue({
      ok: true,
      mode: "live",
      providerId: "stub",
      value: { items: [] },
    }),
    ...overrides,
  } as unknown as RunHistoryStore;
}

describe("countPlanRevisions", () => {
  it("counts reply-resumes, because a round IS the human's reply", () => {
    // A revision round is recorded as `run.resumed`: the ledger lets a BLOCKED run receive only
    // `run.resumed` or `run.terminal`, and that rule is load-bearing rather than incidental.
    const events = [
      { type: "run.accepted" },
      { type: "worker.question" },
      { type: "run.resumed" },
      { type: "worker.question" },
      { type: "run.resumed" },
    ];
    expect(countPlanRevisions(events)).toBe(2);
  });

  it("counts zero when nothing has been revised", () => {
    expect(countPlanRevisions([])).toBe(0);
  });
});

describe("isPlanRevisionCapReached", () => {
  it("is not reached below the cap", () => {
    expect(isPlanRevisionCapReached(4, 5)).toBe(false);
  });

  it("is reached exactly AT the cap", () => {
    // A >= comparison: the boundary is the interesting case, not just above and below it.
    expect(isPlanRevisionCapReached(5, 5)).toBe(true);
  });

  it("stays reached past the cap", () => {
    expect(isPlanRevisionCapReached(6, 5)).toBe(true);
  });
});

describe("recordPlanRevision", () => {
  it("records the round by RESUMING the parked run", async () => {
    const appendEvent = vi.fn().mockResolvedValue({ ok: true, mode: "live", providerId: "stub" });
    const history = historyStub({ appendEvent });

    const result = await recordPlanRevision(history, { runId: "run-1", revisionId: "comment-9" });

    expect(result.ok).toBe(true);
    const event = appendEvent.mock.calls[0][0];
    expect(event.type).toBe("run.resumed");
    expect(event.status).toBe("running");
    expect(event.runId).toBe("run-1");
  });

  it("derives an idempotent event id from the reply, so a re-delivery records once", async () => {
    const appendEvent = vi.fn().mockResolvedValue({ ok: true, mode: "live", providerId: "stub" });
    const history = historyStub({ appendEvent });

    await recordPlanRevision(history, { runId: "run-1", revisionId: "comment-9" });
    await recordPlanRevision(history, { runId: "run-1", revisionId: "comment-9" });
    const first = appendEvent.mock.calls[0][0].eventId;
    const second = appendEvent.mock.calls[1][0].eventId;
    expect(first).toBe(second);
  });

  it("gives a DIFFERENT reply a different event id, so a real round is a new event", async () => {
    const appendEvent = vi.fn().mockResolvedValue({ ok: true, mode: "live", providerId: "stub" });
    const history = historyStub({ appendEvent });

    await recordPlanRevision(history, { runId: "run-1", revisionId: "comment-9" });
    await recordPlanRevision(history, { runId: "run-1", revisionId: "comment-10" });
    expect(appendEvent.mock.calls[0][0].eventId).not.toBe(appendEvent.mock.calls[1][0].eventId);
  });

  it("reports a ledger failure honestly instead of throwing", async () => {
    const history = historyStub({
      appendEvent: vi.fn().mockResolvedValue({
        ok: false,
        mode: "blocked",
        providerId: "stub",
        error: "ledger unavailable",
      }),
    });

    const result = await recordPlanRevision(history, { runId: "run-1", revisionId: "comment-9" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ledger unavailable/);
  });
});

describe("readPlanRevisionCount", () => {
  it("counts rounds across every page", async () => {
    const listRunEvents = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        mode: "live",
        providerId: "stub",
        value: {
          items: [{ sequence: 1, event: { type: "run.resumed" } }],
          nextCursor: { sequence: 1 },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        mode: "live",
        providerId: "stub",
        value: {
          items: [
            { sequence: 2, event: { type: "run.accepted" } },
            { sequence: 3, event: { type: "run.resumed" } },
          ],
        },
      });
    const history = historyStub({ listRunEvents });

    const result = await readPlanRevisionCount(history, "run-1");

    expect(result.ok).toBe(true);
    expect(result.count).toBe(2);
    expect(listRunEvents).toHaveBeenCalledTimes(2);
  });

  it("REPORTS failure rather than returning zero when the ledger cannot be read", async () => {
    // Fail-closed: reporting 0 would let a revision past a cap the operator believes is enforced.
    const history = historyStub({
      listRunEvents: vi.fn().mockResolvedValue({
        ok: false,
        mode: "blocked",
        providerId: "stub",
        value: null,
        error: "ledger unavailable",
      }),
    });

    const result = await readPlanRevisionCount(history, "run-1");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ledger unavailable/);
  });

  it("REPORTS failure when the store THROWS rather than returning a result", async () => {
    // A store returning `{ ok: false }` is only one of the two error shapes. The real store REJECTS on a
    // page limit outside [1, 100]; an unhandled rejection here escaped the whole revision branch and
    // aborted the run. This case and the next are from a live end-to-end run, not from theory.
    const history = historyStub({
      listRunEvents: vi.fn().mockImplementation(() => {
        throw new Error("Run history page limit must be an integer in [1, 100].");
      }),
    });

    const result = await readPlanRevisionCount(history, "run-1");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/page limit/);
  });

  it("works against the REAL sqlite store, whose page limit is capped at 100", async () => {
    // The stub accepts ANY limit, so the recorded suite could not see the bug the live run hit: a 200-row
    // page was rejected by the real store. Only the real store enforces the cap.
    const history = new SqliteRunHistoryStore(":memory:", () => "run-378");
    try {
      const accepted = await history.acceptDelivery({
        deliveryId: "revision-count",
        repo: "ricardoblackskye/agent-eve",
        issue: 378,
        receivedAt: "2026-10-17T09:00:00.000Z",
      });
      const runId = accepted.value?.runId;
      if (!runId) throw new Error("fixture did not return a run ID");

      await history.appendEvent({
        eventId: "revision-count-question",
        runId,
        type: "worker.question",
        stage: "worker",
        occurredAt: "2026-10-17T09:00:01.000Z",
        status: "blocked",
      });

      // Recording a round while the run is blocked is the exact transition the ledger must permit.
      const recorded = await recordPlanRevision(history, { runId, revisionId: "comment-1" });
      expect(recorded.ok).toBe(true);

      const result = await readPlanRevisionCount(history, runId);
      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
    } finally {
      await history.close();
    }
  });
});
