import { describe, expect, it, vi } from "vitest";
import { createOrchestratorGate } from "../agent/orchestrator-gate";

const BASE = {
  env: {
    DF_COST_BUDGET_DRIVER: "postgres",
    DF_COST_BUDGET_DATABASE_URL: "postgres://u@h/db",
  },
  model: "deepseek/deepseek-chat",
  inputTokens: 1000,
};

describe("createOrchestratorGate", () => {
  it("is null when cost governance is not configured, so nothing is gated", () => {
    expect(createOrchestratorGate({ ...BASE, env: {} })).toBeNull();
  });

  it("admits the call when the governor admits it", async () => {
    const admit = vi.fn(async () => ({
      admitted: true,
      reservationId: "res-1",
    }));
    const gate = createOrchestratorGate({
      ...BASE,
      governor: { admit } as never,
    });

    expect(gate).not.toBeNull();
    await expect(gate?.admit()).resolves.toBeUndefined();
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("THROWS on refusal so the turn fails before the provider call", async () => {
    const gate = createOrchestratorGate({
      ...BASE,
      governor: {
        admit: async () => ({ admitted: false, reason: "budget_exceeded" }),
      } as never,
    });

    await expect(gate?.admit()).rejects.toThrow(/budget_exceeded/);
  });

  it("names the category and bounds in the reservation request", async () => {
    const admit = vi.fn(async () => ({ admitted: true, reservationId: "r" }));
    const gate = createOrchestratorGate({
      ...BASE,
      outputTokens: 4096,
      governor: { admit } as never,
    });

    await gate?.admit();

    expect(admit).toHaveBeenCalledWith({
      category: "orchestrator",
      model: "deepseek/deepseek-chat",
      inputTokens: 1000,
      outputTokens: 4096,
    });
  });

  it("treats an unavailable governor as a refusal, never a free pass", async () => {
    const gate = createOrchestratorGate({
      ...BASE,
      governor: {
        admit: async () => ({ admitted: false, reason: "budget_unavailable" }),
      } as never,
    });

    await expect(gate?.admit()).rejects.toThrow(/budget_unavailable/);
  });
});
