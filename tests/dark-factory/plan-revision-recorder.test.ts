import { describe, expect, it, vi } from "vitest";
import {
  countPlanRevisions,
  isPlanRevisionCapReached,
  readPlanRevisionCount,
  recordPlanRevision,
} from "../../agent/lib/dark-factory/plan-revision-recorder";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

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
  it("counts only plan revision events", () => {
    const events = [
      { type: "run.accepted" },
      { type: "worker.question" },
      { type: "run.plan_revised" },
      { type: "run.resumed" },
      { type: "run.plan_revised" },
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
  it("records a revision while the run is blocked", async () => {
    const appendEvent = vi.fn().mockResolvedValue({ ok: true, mode: "live", providerId: "stub" });
    const history = historyStub({ appendEvent });

    const result = await recordPlanRevision(history, { runId: "run-1", revisionId: "comment-9" });

    expect(result.ok).toBe(true);
    const event = appendEvent.mock.calls[0][0];
    expect(event.type).toBe("run.plan_revised");
    expect(event.status).toBe("blocked");
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

  it("gives a DIFFERENT reply a different event id, so a real revision is a new round", async () => {
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
  it("counts revisions across every page", async () => {
    const listRunEvents = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        mode: "live",
        providerId: "stub",
        value: {
          items: [{ sequence: 1, event: { type: "run.plan_revised" } }],
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
            { sequence: 3, event: { type: "run.plan_revised" } },
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
});
