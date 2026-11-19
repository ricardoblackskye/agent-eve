/**
 * #702 - an approval resume must mark the run resumed.
 *
 * Measured: runs `e1af302b` (WebFeedPOC#237) and `30e5e5a7` (WebFeedPOC#239) each persisted exactly
 * three events - `run.accepted`, `worker.question`, `run.terminal` - while the run done in between
 * is missing entirely, and the page reads `blocked` while the run is actually coding.
 *
 * The ledger's rule is explicit: from `blocked` only `run.resumed` or `run.terminal` may follow, and
 * `run.resumed` requires the CURRENT status to be `blocked`. The revision path records one
 * (`recordPlanRevision`), but the plain APPROVAL path recorded nothing - so the summary stayed
 * `blocked`/`worker` and every later work event was refused. Wiring the Definition of Done's store
 * without this made a resuming run BLOCK on its first write:
 *
 *   Run record requires "type" to resume a blocked run before further work events (received "pr.opened").
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import * as recorder from "../../agent/lib/dark-factory/plan-revision-recorder";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const resumedMarker = (recorder as unknown as Record<string, unknown>).recordRunResumed as
  | ((history: SqliteRunHistoryStore, input: { runId: string }) => Promise<{ ok: boolean; error?: string }>)
  | undefined;

describe("#702 an approval resume marks the run resumed", () => {
  it("offers a marker for the APPROVAL resume, alongside the revision one", () => {
    // The revision path has `recordPlanRevision`; the approval path needs its own, because the two
    // must not be the same write - only a revision spends one of the cap's rounds.
    expect(typeof resumedMarker).toBe("function");
  });

  it("moves a parked run to running, so its later work events are accepted", async () => {
    const store = new SqliteRunHistoryStore(":memory:", () => `run-${randomUUID()}`);
    const repo = `owner/approved-${randomUUID().slice(0, 8)}`;

    const accepted = await store.acceptDelivery({
      deliveryId: `delivery-${randomUUID()}`,
      repo,
      issue: 702,
      receivedAt: "2026-11-19T18:00:00.000Z",
    });
    expect(accepted.ok).toBe(true);
    const runId = accepted.value?.runId ?? "";
    expect(runId).not.toBe("");

    // The run parks, exactly as `parkForApproval()` leaves it: blocked, held by the worker.
    const parked = await store.appendEvent({
      eventId: `park:${runId}`,
      runId,
      type: "worker.question",
      stage: "worker",
      occurredAt: "2026-11-19T18:01:00.000Z",
      status: "blocked",
    });
    expect(parked.ok).toBe(true);
    expect(parked.value?.status).toBe("blocked");

    expect(typeof resumedMarker).toBe("function");
    const marked = await resumedMarker!(store, { runId });
    expect(marked.ok, marked.error).toBe(true);

    const after = await store.getRun(runId);
    expect(after.value?.status).toBe("running");

    // The point of the mark: the run's later work events are now accepted rather than refused.
    const prOpened = await store.appendEvent({
      eventId: `pr:${runId}`,
      runId,
      type: "pr.opened",
      stage: "pull-request",
      status: "running",
      prUrl: "https://github.com/ricardoblackskye/agent-eve/pull/1",
      occurredAt: "2026-11-19T18:02:00.000Z",
    });
    expect(prOpened.ok, prOpened.error).toBe(true);
  });
});
