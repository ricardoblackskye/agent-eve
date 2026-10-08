/**
 * #270 — a cost refusal is recorded on the run as a machine-readable code.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  toRunEvent,
  type RunEvent,
} from "../../agent/lib/dark-factory/run-history";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { recordCostRefusal } from "../../agent/lib/dark-factory/cost-refusal-recorder";

const REFUSALS = [
  "not_configured",
  "unpriced_model",
  "budget_exceeded",
  "budget_unavailable",
  "tenant_unconfigured",
] as const;

const stores: SqliteRunHistoryStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

function newHistory(): SqliteRunHistoryStore {
  const h = new SqliteRunHistoryStore(":memory:", () => "run-270");
  stores.push(h);
  return h;
}

async function seedRun(history: SqliteRunHistoryStore) {
  await history.acceptDelivery({
    deliveryId: "delivery-270",
    repo: "ricardoblackskye/agent-eve",
    issue: 270,
    receivedAt: new Date().toISOString(),
  });
}

describe("#270 toRunEvent — costRefusal is a canonical code", () => {
  it("accepts every CostGovernorRefusal code", () => {
    for (const code of REFUSALS) {
      const event = toRunEvent({
        eventId: `e-${code}`,
        runId: "run-270",
        type: "run.terminal",
        stage: "terminal",
        occurredAt: new Date().toISOString(),
        status: "failed",
        costRefusal: code,
      });
      expect(event.costRefusal).toBe(code);
    }
  });

  it("rejects an unknown refusal code", () => {
    expect(() =>
      toRunEvent({
        eventId: "e-bad",
        runId: "run-270",
        type: "run.terminal",
        stage: "terminal",
        occurredAt: new Date().toISOString(),
        status: "failed",
        costRefusal: "made_up" as RunEvent["costRefusal"],
      }),
    ).toThrow(/costRefusal/);
  });

  it("omits costRefusal when it is not supplied", () => {
    const event = toRunEvent({
      eventId: "e-none",
      runId: "run-270",
      type: "run.terminal",
      stage: "terminal",
      occurredAt: new Date().toISOString(),
      status: "failed",
    });
    expect("costRefusal" in event).toBe(false);
  });
});

describe("#270 recordCostRefusal — the code lands on the run", () => {
  it("appends a terminal event that round-trips through the store", async () => {
    const history = newHistory();
    await seedRun(history);

    const result = await recordCostRefusal(history, { runId: "run-270", code: "budget_exceeded" });
    expect(result.ok).toBe(true);

    const events = await history.listRunEvents("run-270");
    const terminal = events.value?.items.find((i) => i.event.type === "run.terminal");
    expect(terminal?.event.costRefusal).toBe("budget_exceeded");
    expect(terminal?.event.status).toBe("failed");

    const run = await history.getRun("run-270");
    expect(run.value?.status).toBe("failed");
  });

  it("is idempotent when re-recorded with the same timestamp", async () => {
    const history = newHistory();
    await seedRun(history);

    const AT = "2026-10-08T00:00:00.000Z";
    await recordCostRefusal(history, { runId: "run-270", code: "unpriced_model", occurredAt: AT });
    const second = await recordCostRefusal(history, { runId: "run-270", code: "unpriced_model", occurredAt: AT });
    expect(second.ok).toBe(true);

    const events = await history.listRunEvents("run-270");
    const refusals = events.value?.items.filter((i) => i.event.type === "run.terminal") ?? [];
    expect(refusals).toHaveLength(1);
  });

  it("reports failure when the run does not exist", async () => {
    const history = newHistory();
    const result = await recordCostRefusal(history, { runId: "missing-run", code: "not_configured" });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
