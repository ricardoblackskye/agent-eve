import { describe, expect, it, vi } from "vitest";

import { createCostGate } from "../../agent/lib/dark-factory/cost-gate";

/**
 * #637 — the gate must reserve the bound it is HANDED for this call.
 *
 * The gate was constructed with the model's whole context window and `admit()` took no
 * argument, so every reservation was `window x input price + output bound x output price`:
 * $1.2156 a turn on `deepseek/deepseek-v4.1-flash`. `admit()` refuses when
 * `spent + reserved + estimate > cap`, so once a period's headroom fell below that figure
 * — `spent > $78.78` of an $80 cap — every turn was refused before the provider call and the
 * production evals failed with `MODEL_SELECTION_FAILED`.
 *
 * The constructed bound is kept as the fallback: it is the worst case, which is the safe
 * direction (ADR 0027).
 */

const MODEL = "deepseek/deepseek-v4.1-flash";
const WINDOW = 1_048_576;

function spyGovernor() {
  const admit = vi.fn(
    async (_input: { category: string; model: string; inputTokens: number; outputTokens: number }) => ({
      admitted: true,
      reservationId: "res-spy",
      estimatedUsd: 0,
      period: "2026-11",
    }),
  );
  const governor = {
    id: "governor:spy",
    period: () => "2026-11",
    admit,
    settle: async () => ({ ok: true }),
    status: async () => [],
  };
  return { governor, admit };
}

function gateWith(admitSpy: ReturnType<typeof spyGovernor>) {
  const gate = createCostGate({
    category: "orchestrator",
    env: {},
    model: MODEL,
    inputTokens: WINDOW,
    governor: admitSpy.governor as never,
  });
  expect(gate).not.toBeNull();
  return gate!;
}

describe("#637 the gate reserves the bound it is handed", () => {
  it("uses the per-call bound when the caller supplies one", async () => {
    const spy = spyGovernor();
    await gateWith(spy).admit(1_200);

    expect(spy.admit.mock.calls[0][0].inputTokens).toBe(1_200);
  });

  it("falls back to the constructed window when no usable bound is supplied", async () => {
    // A refusal to reserve is the one thing this must never do: an absent, negative,
    // non-finite or otherwise nonsense bound keeps the worst case.
    for (const nonsense of [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const spy = spyGovernor();
      await gateWith(spy).admit(nonsense as number | undefined);
      expect(spy.admit.mock.calls[0][0].inputTokens, `bound '${String(nonsense)}'`).toBe(WINDOW);
    }
  });

  it("still refuses a call the store rejects, whatever bound was handed in", async () => {
    const admit = vi.fn(async () => ({
      admitted: false,
      reason: "budget_exceeded",
      period: "2026-11",
      error: "Reservation would exceed the configured budget cap.",
    }));
    const gate = createCostGate({
      category: "orchestrator",
      env: {},
      model: MODEL,
      inputTokens: WINDOW,
      governor: { id: "governor:spy", period: () => "2026-11", admit, settle: async () => ({ ok: true }), status: async () => [] } as never,
      log: () => {},
    })!;

    await expect(gate.admit(10)).rejects.toThrow(/budget_exceeded/);
  });
});
