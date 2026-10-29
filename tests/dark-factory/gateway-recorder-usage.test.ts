import { describe, expect, it, vi } from "vitest";
import { createGatewayRecorder } from "../../agent/lib/dark-factory/gateway-recorder";
import type { RunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";

function stubStore() {
  const appended: Array<Record<string, unknown>> = [];
  const store = {
    appendEvent: vi.fn(async (event: Record<string, unknown>) => {
      appended.push(event);
      return { ok: true, mode: "live", providerId: "stub" };
    }),
  } as unknown as RunHistoryStore;
  return { store, appended };
}

const base = { runId: "run-1", model: "m", reservationId: "res-1" };

describe("the gateway's cost event (#532)", () => {
  it("records the SETTLED cost when one was measured, not the reservation estimate", async () => {
    const { store, appended } = stubStore();
    await createGatewayRecorder(store).recordUsage({
      ...base,
      estimatedUsd: 0.16,
      costUsd: 0.0932,
      tokensIn: 1200,
      tokensOut: 340,
    });

    expect(appended).toHaveLength(1);
    expect(appended[0].costUsd).toBeCloseTo(0.0932, 10);
    expect(appended[0].costUsd).not.toBeCloseTo(0.16, 10);
  });

  it("falls back to the estimate only when nothing was measured", async () => {
    const { store, appended } = stubStore();
    await createGatewayRecorder(store).recordUsage({ ...base, estimatedUsd: 0.16 });

    expect(appended[0].costUsd).toBeCloseTo(0.16, 10);
  });

  it("never fails a forwarded call when the run history is down", async () => {
    const store = {
      appendEvent: vi.fn(async () => {
        throw new Error("history down");
      }),
    } as unknown as RunHistoryStore;

    await expect(
      createGatewayRecorder(store).recordUsage({ ...base, estimatedUsd: 0.16, costUsd: 0.1 }),
    ).resolves.toBeUndefined();
  });
});
