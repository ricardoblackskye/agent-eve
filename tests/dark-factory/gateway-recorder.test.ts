import { describe, expect, it, vi } from "vitest";
import { createGatewayRecorder } from "../../agent/lib/dark-factory/gateway-recorder";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

function fakeStore() {
  const events: Array<Record<string, unknown>> = [];
  const store = {
    appendEvent: vi.fn(async (e: Record<string, unknown>) => {
      events.push(e);
      return {
        ok: true,
        mode: "live" as const,
        providerId: "fake",
        value: {},
        duplicate: false,
      };
    }),
  } as unknown as RunHistoryStore;
  return { store, events };
}

describe("createGatewayRecorder", () => {
  it("records a run.cost event for a forwarded call", async () => {
    const { store, events } = fakeStore();
    const rec = createGatewayRecorder(store);
    await rec.recordUsage({
      runId: "run-1",
      model: "m",
      reservationId: "r",
      estimatedUsd: 0.01,
      tenantId: undefined,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.cost");
    expect(events[0]?.runId).toBe("run-1");
    expect(events[0]?.costUsd).toBe(0.01);
  });

  it("records a cost-refusal (run.terminal with the refusal code) for a refused call", async () => {
    const { store, events } = fakeStore();
    const rec = createGatewayRecorder(store);
    await rec.recordRefusal({
      runId: "run-1",
      model: "m",
      reason: "not_configured",
      tenantId: undefined,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("run.terminal");
    expect(events[0]?.costRefusal).toBe("not_configured");
  });

  it("resolves void even when the store write throws", async () => {
    const throwing = {
      appendEvent: async () => {
        throw new Error("dead");
      },
    } as unknown as RunHistoryStore;
    const rec = createGatewayRecorder(throwing);
    await expect(
      rec.recordUsage({
        runId: "r",
        model: "m",
        reservationId: "x",
        estimatedUsd: 1,
        tenantId: undefined,
      }),
    ).resolves.toBeUndefined();
  });
});
