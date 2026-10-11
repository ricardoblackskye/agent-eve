/**
 * #307 — operator retry / abort, the ledger-reaching half.
 *
 * Acceptance criteria under test:
 * - retry re-dispatches a FAILED run, as a NEW run
 * - retry of a run that did not fail is refused
 * - abort drives the ledger's terminal abort transition
 * - the delivery identity is derived from the run, so a double-click is idempotent
 */

import { describe, it, expect, vi } from "vitest";
import {
  performOperatorRunAction,
  type DispatchFn,
} from "../../agent/lib/dark-factory/operator-actions";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

const AT = "2026-10-10T09:00:00.000Z";

async function seedRun(status: "failed" | "running") {
  const store = new SqliteRunHistoryStore(":memory:", () => "run-307");
  await store.acceptDelivery({
    deliveryId: "delivery-1",
    repo: "owner/repo",
    issue: 307,
    receivedAt: AT,
  });
  if (status === "failed") {
    await store.appendEvent({
      eventId: "evt-terminal",
      runId: "run-307",
      type: "run.terminal",
      stage: "terminal",
      status: "failed",
      occurredAt: "2026-10-10T09:01:00.000Z",
    });
  }
  return store;
}

function dispatcher(result: Partial<Awaited<ReturnType<DispatchFn>>> = {}) {
  return vi.fn(async () => ({
    ok: true,
    status: "dispatched",
    reason: "dispatched",
    ...result,
  })) as unknown as DispatchFn & {
    mock: { calls: unknown[][] };
  };
}

describe("#307 operator retry", () => {
  it("re-dispatches a FAILED run as a new run", async () => {
    const runHistory = await seedRun("failed");
    const dispatch = dispatcher({ runId: "run-new" });

    const out = await performOperatorRunAction(
      { runHistory, dispatch, now: () => "2026-10-10T09:05:00.000Z" },
      {
        action: "retry",
        runId: "run-307",
        actor: "op@example.com",
        reason: "transient failure",
      },
    );

    expect(out.ok).toBe(true);
    expect(dispatch.mock.calls).toHaveLength(1);
    const [decision, deps] = dispatch.mock.calls[0] as [
      { kind: string; repo?: string; issue?: number },
      { deliveryId: string },
    ];
    expect(decision.kind).toBe("trigger");
    expect(decision.repo).toBe("owner/repo");
    expect(decision.issue).toBe(307);
    expect(deps.deliveryId).toBe("operator-retry:run-307");
    expect(out.runId).toBe("run-new");
  });

  it("refuses to retry a run that did not fail", async () => {
    const runHistory = await seedRun("running");
    const dispatch = dispatcher();

    const out = await performOperatorRunAction(
      { runHistory, dispatch },
      { action: "retry", runId: "run-307", actor: "op@example.com" },
    );

    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/failed/i);
    expect(dispatch.mock.calls).toHaveLength(0);
  });

  it("refuses an unknown run without dispatching", async () => {
    const runHistory = await seedRun("failed");
    const dispatch = dispatcher();

    const out = await performOperatorRunAction(
      { runHistory, dispatch },
      { action: "retry", runId: "does-not-exist", actor: "op@example.com" },
    );

    expect(out.ok).toBe(false);
    expect(dispatch.mock.calls).toHaveLength(0);
  });
});

describe("#307 operator abort", () => {
  it("drives the ledger's terminal abort transition for the run", async () => {
    const runHistory = await seedRun("running");
    const dispatch = dispatcher({
      status: "aborted",
      runId: "run-307",
      runStatus: "aborted",
    });

    const out = await performOperatorRunAction(
      { runHistory, dispatch },
      {
        action: "abort",
        runId: "run-307",
        actor: "op@example.com",
        reason: "wrong approach",
      },
    );

    expect(out.ok).toBe(true);
    const [decision, deps] = dispatch.mock.calls[0] as [
      { kind: string; issue?: number },
      { deliveryId: string },
    ];
    expect(decision.kind).toBe("abort");
    expect(decision.issue).toBe(307);
    expect(deps.deliveryId).toBe("operator-abort:run-307");
  });

  it("uses a DETERMINISTIC delivery identity so a double-click cannot abort twice", async () => {
    const runHistory = await seedRun("running");
    const dispatch = dispatcher();

    for (let i = 0; i < 2; i++) {
      await performOperatorRunAction(
        { runHistory, dispatch },
        { action: "abort", runId: "run-307", actor: "op@example.com" },
      );
    }

    const ids = dispatch.mock.calls.map(
      (call) => (call[1] as { deliveryId: string }).deliveryId,
    );
    expect(ids).toEqual(["operator-abort:run-307", "operator-abort:run-307"]);
  });
});