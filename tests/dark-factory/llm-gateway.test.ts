import { describe, expect, it, vi } from "vitest";
import type { CostCategory } from "../../agent/lib/dark-factory/cost-budget";
import type {
  CostGovernor,
  CostGovernorAdmitInput,
  CostGovernorDecision,
} from "../../agent/lib/dark-factory/cost-governor";
import {
  bearerToken,
  createInMemoryLeaseAuthority,
  handleGatewayRequest,
  LEASE_REFUSED_MESSAGE,
  type GatewayRefusalRecord,
  type GatewayUsageRecord,
  type LeaseAuthority,
  type LlmGatewayDeps,
} from "../../agent/lib/dark-factory/llm-gateway";

/**
 * #281 T3 — the governed gateway core, driven with fixtures so no provider key is needed.
 *
 * The two properties under test are the ones that make this safe to expose to a sandbox: a refusal
 * must cost nothing (never forward), and a lease failure must be indistinguishable across causes.
 */
function governorStub(decision: CostGovernorDecision, settled: string[] = []): CostGovernor {
  return {
    id: "stub",
    period: () => "2026-10",
    admit: vi.fn(async (_input: CostGovernorAdmitInput) => decision),
    settle: vi.fn(async (reservationId: string) => {
      settled.push(reservationId);
      return { ok: true };
    }),
    status: async () => [],
  };
}

const LEASE = { runId: "run-1", tenantId: "tenant-a" };
const leases: LeaseAuthority = { resolve: (token) => (token === "lease-abc" ? LEASE : undefined) };

function deps(over: Partial<LlmGatewayDeps>): LlmGatewayDeps {
  return {
    leases,
    allowedModels: ["deepseek/deepseek-chat"],
    forwardUpstream: vi.fn(async () => ({ id: "completion-1" })),
    ...over,
  };
}
const ok = { admitted: true, reservationId: "res-1", estimatedUsd: 0.01 };

describe("#281 llm gateway core", () => {
  it("parses a bearer token, and rejects anything else", () => {
    expect(bearerToken("Bearer lease-abc")).toBe("lease-abc");
    expect(bearerToken("Basic xyz")).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
    expect(bearerToken(42)).toBeUndefined();
  });

  it("refuses an absent AND an unknown lease with the SAME error, and never forwards", async () => {
    for (const authorization of [undefined, "Bearer nope"]) {
      const d = deps({ governor: governorStub(ok) });
      const result = await handleGatewayRequest(
        { authorization, model: "deepseek/deepseek-chat", payload: {}, inputTokens: 10, outputTokens: 10 },
        d,
      );
      expect(result).toEqual({ status: 401, error: LEASE_REFUSED_MESSAGE });
      expect(d.forwardUpstream).not.toHaveBeenCalled();
    }
  });

  it("rejects a non-pinned model before any governance or spend", async () => {
    const governor = governorStub(ok);
    const d = deps({ governor });
    const result = await handleGatewayRequest(
      { authorization: "Bearer lease-abc", model: "gpt-5-ultra", payload: {}, inputTokens: 10, outputTokens: 10 },
      d,
    );
    expect(result).toMatchObject({ status: 400 });
    expect(governor.admit).not.toHaveBeenCalled();
    expect(d.forwardUpstream).not.toHaveBeenCalled();
  });

  it("forwards on admission, settles, and records usage attributed to the lease tenant", async () => {
    const settled: string[] = [];
    const governor = governorStub(ok, settled);
    const usage: GatewayUsageRecord[] = [];
    const d = deps({ governor, recordUsage: async (u) => void usage.push(u) });
    const result = await handleGatewayRequest(
      { authorization: "Bearer lease-abc", model: "deepseek/deepseek-chat", payload: { messages: [] }, inputTokens: 10, outputTokens: 10 },
      d,
    );
    expect(result).toEqual({ status: 200, body: { id: "completion-1" } });
    expect(d.forwardUpstream).toHaveBeenCalledTimes(1);
    expect(settled).toEqual(["res-1"]);
    expect(usage).toEqual([
      { runId: "run-1", tenantId: "tenant-a", model: "deepseek/deepseek-chat", reservationId: "res-1", estimatedUsd: 0.01 },
    ]);
  });

  it("forwards the tenant to the governor so sandbox spend cannot fall silently to GLOBAL", async () => {
    const governor = governorStub(ok);
    const d = deps({ governor });
    await handleGatewayRequest(
      { authorization: "Bearer lease-abc", model: "deepseek/deepseek-chat", payload: {}, inputTokens: 5, outputTokens: 5 },
      d,
    );
    expect(governor.admit).toHaveBeenCalledWith(
      expect.objectContaining({ category: "developer", tenantId: "tenant-a" }),
    );
  });

  it("refuses a budget decision WITHOUT forwarding (zero spend) and records the refusal", async () => {
    const refusals: GatewayRefusalRecord[] = [];
    const d = deps({
      governor: governorStub({ admitted: false, reason: "budget_exceeded" }),
      recordRefusal: async (r) => void refusals.push(r),
    });
    const result = await handleGatewayRequest(
      { authorization: "Bearer lease-abc", model: "deepseek/deepseek-chat", payload: {}, inputTokens: 10, outputTokens: 10 },
      d,
    );
    expect(result).toMatchObject({ status: 402, reason: "budget_exceeded" });
    expect(d.forwardUpstream).not.toHaveBeenCalled();
    expect(refusals).toEqual([
      { runId: "run-1", tenantId: "tenant-a", model: "deepseek/deepseek-chat", reason: "budget_exceeded" },
    ]);
  });

  it("reports an upstream failure generically, echoing no upstream detail", async () => {
    const d = deps({
      governor: governorStub(ok),
      forwardUpstream: vi.fn(async () => {
        throw new Error("provider said: key sk-secret leaked");
      }),
    });
    const result = await handleGatewayRequest(
      { authorization: "Bearer lease-abc", model: "deepseek/deepseek-chat", payload: {}, inputTokens: 10, outputTokens: 10 },
      d,
    );
    expect(result.status).toBe(502);
    expect(JSON.stringify(result)).not.toMatch(/sk-secret|provider said/);
  });

  it("REFUSES rather than forwarding when governance is not configured (no fail-open)", async () => {
    const refusals: GatewayRefusalRecord[] = [];
    const d = deps({ governor: undefined, recordRefusal: async (r) => void refusals.push(r) });
    const result = await handleGatewayRequest(
      { authorization: "Bearer lease-abc", model: "deepseek/deepseek-chat", payload: {}, inputTokens: 1, outputTokens: 1 },
      d,
    );
    expect(result).toMatchObject({ status: 402, reason: "not_configured" });
    expect(d.forwardUpstream).not.toHaveBeenCalled();
    expect(refusals[0]?.reason).toBe("not_configured");
  });

  it("issues opaque, run-bound leases that revoke cleanly", () => {
    const authority = createInMemoryLeaseAuthority();
    const token = authority.issue({ runId: "run-9", tenantId: "tenant-z" });
    // Opacity: the token reveals nothing about what it grants.
    expect(token).not.toContain("run-9");
    expect(token).not.toContain("tenant-z");
    expect(authority.resolve(token)).toEqual({ runId: "run-9", tenantId: "tenant-z" });
    expect(authority.resolve("not-a-token")).toBeUndefined();
    authority.revoke(token);
    expect(authority.resolve(token)).toBeUndefined();
    authority.revoke("never-existed"); // revoking an unknown token is a no-op, not an error
  });

  it("records no field that could carry a credential", async () => {
    const usage: GatewayUsageRecord[] = [];
    const d = deps({ governor: governorStub(ok), recordUsage: async (u) => void usage.push(u) });
    await handleGatewayRequest(
      { authorization: "Bearer lease-abc", model: "deepseek/deepseek-chat", payload: {}, inputTokens: 1, outputTokens: 1 },
      d,
    );
    expect(Object.keys(usage[0]!).sort()).toEqual(
      ["estimatedUsd", "model", "reservationId", "runId", "tenantId"],
    );
  });
});
