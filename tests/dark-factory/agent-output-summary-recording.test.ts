/**
 * #558 — the run ledger stores a bounded, redacted summary of captured agent
 * output, so a run's notable output is readable against the run and not only on
 * the ticket. This mirrors the scalar `costRefusal` path (#270), not the JSON
 * fields: the value is one bounded string.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_AGENT_OUTPUT_CHARS,
  toRunEvent,
  type RunEvent,
} from "../../agent/lib/dark-factory/run-history";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { MAX_QUESTION_CHARS } from "../../agent/lib/dark-factory/worker-reporter";

const SUMMARY = "no allow-listed command applies to this change";

const stores: SqliteRunHistoryStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

function newHistory(): SqliteRunHistoryStore {
  const h = new SqliteRunHistoryStore(":memory:", () => "run-558");
  stores.push(h);
  return h;
}

async function seedRun(history: SqliteRunHistoryStore) {
  await history.acceptDelivery({
    deliveryId: "delivery-558",
    repo: "ricardoblackskye/agent-eve",
    issue: 558,
    receivedAt: new Date().toISOString(),
  });
}

function event(overrides: Partial<RunEvent> = {}): Partial<RunEvent> {
  return {
    eventId: "evt-558",
    runId: "run-558",
    type: "worker.roadblock",
    stage: "worker",
    occurredAt: new Date().toISOString(),
    status: "running",
    ...overrides,
  };
}

describe("toRunEvent — the captured-output summary is optional and bounded", () => {
  it("carries a captured summary through to the event", () => {
    const parsed = toRunEvent(event({ agentOutputSummary: SUMMARY }));
    expect(parsed.agentOutputSummary).toBe(SUMMARY);
  });

  it("rejects a summary longer than the bound", () => {
    // Valid case first: with only the rejection case, a validator that threw for
    // everything would satisfy it and prove nothing.
    expect(
      toRunEvent(event({ agentOutputSummary: SUMMARY })).agentOutputSummary,
    ).toBe(SUMMARY);
    expect(() =>
      toRunEvent({
        ...event(),
        agentOutputSummary: "x".repeat(MAX_AGENT_OUTPUT_CHARS + 1),
      }),
    ).toThrow(/agentOutputSummary/i);
  });

  it("rejects an empty summary rather than storing a blank row", () => {
    expect(() =>
      toRunEvent({ ...event(), agentOutputSummary: "   " }),
    ).toThrow(/agentOutputSummary/i);
  });

  it("leaves the field absent when nothing was captured", () => {
    expect("agentOutputSummary" in toRunEvent(event())).toBe(false);
  });

  it("GUARD: the ledger bound matches the reporter bound it must satisfy", () => {
    // The ledger cannot import the reporter's constant (worker-reporter imports
    // run-history, so that would be a cycle), so the two are kept equal by this
    // guard instead of by hope: a summary the ledger accepts must be one the
    // reporter will post.
    expect(MAX_AGENT_OUTPUT_CHARS).toBe(MAX_QUESTION_CHARS);
  });
});

describe("the sqlite store round-trips the captured summary (#558)", () => {
  it("persists and reads back the summary on a roadblock event", async () => {
    const history = newHistory();
    await seedRun(history);

    const appended = await history.appendEvent(
      toRunEvent(event({ agentOutputSummary: SUMMARY })),
    );
    expect(appended.ok).toBe(true);

    const events = await history.listRunEvents("run-558");
    const roadblock = (events.value?.items ?? []).find(
      (item) => item.event.type === "worker.roadblock",
    );

    expect(roadblock?.event.agentOutputSummary).toBe(SUMMARY);
  });
});
