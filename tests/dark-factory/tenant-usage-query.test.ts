/**
 * Tenant usage reporting (#213, epic #212 R1).
 *
 * The two rules that matter most here:
 *  - Unattributed usage is its OWN bucket. It is never folded into a customer's
 *    total, because unattributed spend is not any customer's spend.
 *  - An unmeasured value stays ABSENT so the UI can render `—`. A `0` would be
 *    a claim that we measured zero, which is a different (and false) statement.
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryUsageStore,
  type UsageStore,
} from "../../agent/lib/dark-factory/usage-store";
import { toUsageEvent, type UsageEvent } from "../../agent/lib/dark-factory/usage-ledger";
import { queryTenantUsage } from "../../agent/lib/dark-factory/tenant-usage-query";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function event(overrides: Partial<UsageEvent> = {}) {
  return toUsageEvent({
    runId: "run-1",
    taskType: "orchestrator",
    model: "deepseek/deepseek-v4.1-flash",
    ts: "2026-10-01T10:00:00.000Z",
    ...overrides,
  });
}

async function storeWith(events: ReturnType<typeof event>[]) {
  const store = new InMemoryUsageStore();
  for (const item of events) await store.record(item);
  return store;
}

describe("queryTenantUsage", () => {
  it("aggregates measured usage and cost per tenant", async () => {
    const store = await storeWith([
      event({ tenantId: T1, tokensIn: 10, tokensOut: 5, costUsd: 0.25 }),
      event({ tenantId: T1, tokensIn: 2, tokensOut: 1, costUsd: 0.05 }),
      event({ tenantId: T2, tokensIn: 7, tokensOut: 3, costUsd: 0.1 }),
    ]);
    const result = await queryTenantUsage(store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const t1 = result.report.byTenant.find((entry) => entry.tenantId === T1);
    expect(t1).toMatchObject({ calls: 2, tokensIn: 12, tokensOut: 6 });
    expect(t1?.costUsd).toBeCloseTo(0.3, 6);
    expect(result.report.byTenant.map((entry) => entry.tenantId)).toEqual([T1, T2]);
  });

  it("puts unattributed usage in its own bucket, never a customer's total", async () => {
    const store = await storeWith([
      event({ tenantId: T1, costUsd: 0.1 }),
      event({ costUsd: 0.99 }),
    ]);
    const result = await queryTenantUsage(store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.report.byTenant.map((entry) => entry.tenantId)).toEqual([T1]);
    expect(result.report.byTenant[0]?.costUsd).toBeCloseTo(0.1, 6);

    expect(result.report.unassigned.calls).toBe(1);
    expect(result.report.unassigned.costUsd).toBeCloseTo(0.99, 6);
    // A genuine "no tenant" — never a placeholder id.
    expect(result.report.unassigned).not.toHaveProperty("tenantId");
  });

  it("splits measured from unmeasured without inventing zeros", async () => {
    const store = await storeWith([
      event({ tenantId: T1, tokensIn: 5 }),
      event({ tenantId: T1 }),
    ]);
    const result = await queryTenantUsage(store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const t1 = result.report.byTenant[0];
    expect(t1?.calls).toBe(2);
    expect(t1?.unmeasured).toBe(1);
    expect(t1?.tokensIn).toBe(5);
    // Nobody reported a cost, so there is no cost figure to show — absent.
    expect(t1).not.toHaveProperty("costUsd");
    expect(result.report.unmeasured).toBe(1);
  });

  it("applies the time window", async () => {
    const store = await storeWith([
      event({ tenantId: T1, costUsd: 0.1, ts: "2026-10-01T09:00:00.000Z" }),
      event({ tenantId: T1, costUsd: 0.2, ts: "2026-10-01T11:00:00.000Z" }),
    ]);
    const result = await queryTenantUsage(store, {
      from: "2026-10-01T10:00:00.000Z",
      to: "2026-10-01T12:00:00.000Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.byTenant[0]?.calls).toBe(1);
    expect(result.report.byTenant[0]?.costUsd).toBeCloseTo(0.2, 6);
  });

  it("filters to a single tenant when asked", async () => {
    const store = await storeWith([
      event({ tenantId: T1, costUsd: 0.1 }),
      event({ tenantId: T2, costUsd: 0.2 }),
    ]);
    const result = await queryTenantUsage(store, { tenantId: T2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.byTenant.map((entry) => entry.tenantId)).toEqual([T2]);
  });

  it("reports a malformed window as a 400, not a 503", async () => {
    const store = await storeWith([]);
    const result = await queryTenantUsage(store, { from: "not-a-date" });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("reports an inverted window as a 400", async () => {
    const store = await storeWith([]);
    const result = await queryTenantUsage(store, {
      from: "2026-10-02T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("reports an unavailable ledger as a 503, distinct from a bad request", async () => {
    const failing = {
      id: "broken",
      record: async () => ({ ok: true, mode: "live", providerId: "broken" }),
      aggregate: async () => ({
        ok: false,
        mode: "blocked",
        providerId: "broken",
        value: null,
        error: "ledger unavailable",
      }),
      close: () => {},
    } as unknown as UsageStore;

    const result = await queryTenantUsage(failing);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });
});