/**
 * #270 — the category-parameterized cost gate (generalizes #217's orchestrator gate).
 *
 * The contract: OPT-IN (null when unconfigured), and a refusal THROWS so the caller
 * fails before the provider call. Every surface (#270) shares this one gate.
 */
import { describe, expect, it, vi } from "vitest";
import { createCostGate } from "../../agent/lib/dark-factory/cost-gate";

const BASE = {
  category: "orchestrator" as const,
  env: {
    DF_COST_BUDGET_DRIVER: "postgres",
    DF_COST_BUDGET_DATABASE_URL: "postgres://u@h/db",
  },
  model: "deepseek/deepseek-chat",
  inputTokens: 1000,
};

describe("createCostGate (#270)", () => {
  it("is null when cost governance is not configured, so nothing is gated", () => {
    expect(createCostGate({ ...BASE, env: {} })).toBeNull();
  });

  it("admits the call when the governor admits it", async () => {
    const admit = vi.fn(async () => ({ admitted: true, reservationId: "res-1" }));
    const gate = createCostGate({ ...BASE, governor: { admit } as never });

    expect(gate).not.toBeNull();
    await expect(gate?.admit()).resolves.toBeUndefined();
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("THROWS on refusal so the caller fails before the provider call", async () => {
    const gate = createCostGate({
      ...BASE,
      category: "developer",
      governor: { admit: async () => ({ admitted: false, reason: "budget_exceeded" }) } as never,
    });

    await expect(gate?.admit()).rejects.toThrow(/developer cost gate refused/);
    await expect(gate?.admit()).rejects.toThrow(/budget_exceeded/);
  });

  it("names the category and bounds in the reservation request", async () => {
    const admit = vi.fn(async () => ({ admitted: true, reservationId: "r" }));
    const gate = createCostGate({ ...BASE, category: "pr-review", outputTokens: 4096, governor: { admit } as never });

    await gate?.admit();

    expect(admit).toHaveBeenCalledWith({
      category: "pr-review",
      model: "deepseek/deepseek-chat",
      inputTokens: 1000,
      outputTokens: 4096,
    });
  });

  it("forwards the tenant when present, and omits it when absent", async () => {
    const withTenant = vi.fn(async () => ({ admitted: true, reservationId: "r" }));
    await createCostGate({ ...BASE, tenantId: "t-1", governor: { admit: withTenant } as never })?.admit();
    expect(withTenant).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t-1" }));

    const withoutTenant = vi.fn(async () => ({ admitted: true, reservationId: "r" }));
    await createCostGate({ ...BASE, governor: { admit: withoutTenant } as never })?.admit();
    expect(withoutTenant).toHaveBeenCalledWith(
      expect.not.objectContaining({ tenantId: expect.anything() }),
    );
  });

  it("treats an unavailable governor as a refusal, never a free pass", async () => {
    const gate = createCostGate({
      ...BASE,
      governor: { admit: async () => ({ admitted: false, reason: "budget_unavailable" }) } as never,
    });

    await expect(gate?.admit()).rejects.toThrow(/budget_unavailable/);
  });
});
