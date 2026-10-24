/**
 * #270 — the category-parameterized cost gate (generalizes #217's orchestrator gate).
 *
 * The contract: OPT-IN (null when unconfigured), and a refusal THROWS so the caller
 * fails before the provider call. Every surface (#270) shares this one gate.
 */
import { describe, expect, it, vi } from "vitest";
import { createCostGate } from "../../agent/lib/dark-factory/cost-gate";
import { CostRefusedError } from "../../agent/lib/dark-factory/cost-governor";

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
    await expect(gate?.admit()).resolves.toMatchObject({ settle: expect.any(Function) });
    expect(admit).toHaveBeenCalledTimes(1);
  });

  it("returns an admission that settles the reservation it took (#443)", async () => {
    const settle = vi.fn(async () => ({ ok: true }));
    const gate = createCostGate({
      ...BASE,
      governor: {
        admit: vi.fn(async () => ({ admitted: true, reservationId: "res-1", estimatedUsd: 2.5 })),
        settle,
      } as never,
    });

    const admission = await gate?.admit();

    expect(admission?.settle).toBeTypeOf("function");
    await admission?.settle(12.5);
    expect(settle).toHaveBeenCalledWith("res-1", 12.5);
  });

  it("settles from provider usage, priced with the model the gate reserved against (#443)", async () => {
    const settle = vi.fn(async () => ({ ok: true }));
    const gate = createCostGate({
      ...BASE,
      governor: {
        admit: vi.fn(async () => ({ admitted: true, reservationId: "res-1" })),
        settle,
      } as never,
    });

    const admission = await gate?.admit();
    // 1k in + 1k out of deepseek/deepseek-chat is priced by the shared table, not guessed.
    await admission?.settleFromUsage({ inputTokens: 1000, outputTokens: 1000 });

    expect(settle).toHaveBeenCalledTimes(1);
    const [id, cost] = settle.mock.calls[0] as unknown as [string, number];
    expect(id).toBe("res-1");
    expect(cost).toBeCloseTo(0.0004, 10);
  });

  it("falls back to the estimate when the model has no price, rather than releasing (#443)", async () => {
    const settle = vi.fn(async () => ({ ok: true }));
    const gate = createCostGate({
      ...BASE,
      model: "unpriced/model",
      governor: {
        admit: vi.fn(async () => ({ admitted: true, reservationId: "res-2" })),
        settle,
      } as never,
    });

    const admission = await gate?.admit();
    await admission?.settleFromUsage({ inputTokens: 1000, outputTokens: 1000 });

    // null charges the reserved estimate; 0 would release budget for a call that ran.
    expect(settle).toHaveBeenCalledWith("res-2", null);
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

  it("refuses with a TYPED error carrying the decision, not a bare message (#458)", async () => {
    const gate = createCostGate({
      ...BASE,
      category: "developer",
      governor: {
        admit: async () => ({
          admitted: false,
          reason: "budget_exceeded",
          period: "2026-10",
          error: "Reservation would exceed the configured budget cap.",
        }),
      } as never,
    });

    let thrown: unknown;
    try {
      await gate?.admit();
    } catch (error) {
      thrown = error;
    }

    // Fields, not only a message: a bare Error carrying the reason inside a string is
    // exactly the defect #458 exists to remove. The message is asserted too, because the
    // operator-facing form has to name the reason and the store's own words on its own.
    expect(thrown).toBeInstanceOf(CostRefusedError);
    const refusal = thrown as CostRefusedError;
    expect(refusal.reason).toBe("budget_exceeded");
    expect(refusal.period).toBe("2026-10");
    expect(refusal.category).toBe("developer");
    expect(refusal.storeError).toBe("Reservation would exceed the configured budget cap.");
    expect(refusal.message).toContain("Reservation would exceed the configured budget cap.");
  });

  it("logs ONE structured line at the refusal, naming reason, category and the store's words (#458)", async () => {
    const log = vi.fn();
    const gate = createCostGate({
      ...BASE,
      category: "orchestrator",
      log,
      governor: {
        admit: async () => ({
          admitted: false,
          reason: "budget_exceeded",
          period: "2026-10",
          error: "Reservation would exceed the configured budget cap.",
        }),
      } as never,
    });

    await expect(gate?.admit()).rejects.toBeInstanceOf(CostRefusedError);

    // Exactly once: a refusal must not narrate itself twice.
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain("[dark-factory]");
    expect(line).toContain("reason=budget_exceeded");
    expect(line).toContain("category=orchestrator");
    expect(line).toContain("period=2026-10");
    expect(line).toContain("Reservation would exceed the configured budget cap.");
  });

  it("does not log when the call is admitted (#458)", async () => {
    const log = vi.fn();
    const gate = createCostGate({
      ...BASE,
      log,
      governor: { admit: async () => ({ admitted: true, reservationId: "res-1" }) } as never,
    });

    await expect(gate?.admit()).resolves.toBeDefined();
    expect(log).not.toHaveBeenCalled();
  });
});
