import { describe, expect, it } from "vitest";
import type { CostBudget } from "../../agent/lib/dark-factory/cost-budget";
import { buildTenantBudgetReport } from "../../agent/lib/dark-factory/tenant-budget-query";
import type { Tenant } from "../../agent/lib/dark-factory/tenant";

const PERIOD = "2026-10";

const tenants: Tenant[] = [
  { id: "t-a", slug: "acme", name: "Acme", status: "active", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "t-b", slug: "globex", name: "Globex", status: "active", createdAt: "2026-01-01T00:00:00.000Z" },
];

function budget(overrides: Partial<CostBudget>): CostBudget {
  return {
    category: "orchestrator",
    period: PERIOD,
    capUsd: 10,
    spentUsd: 0,
    callCount: 0,
    reservedUsd: 0,
    ...overrides,
  };
}

describe("buildTenantBudgetReport (#231)", () => {
  it("reports cap, settled, reserved and remaining per tenant", () => {
    const report = buildTenantBudgetReport({
      tenants,
      period: PERIOD,
      available: true,
      budgets: [
        budget({ tenantId: "t-a", capUsd: 10, spentUsd: 3, reservedUsd: 2, callCount: 4 }),
      ],
    });
    const acme = report.tenants.find((t) => t.tenantId === "t-a");
    const row = acme?.budgets[0];
    expect(row?.capUsd).toBe(10);
    expect(row?.settledUsd).toBe(3);
    expect(row?.reservedUsd).toBe(2);
    expect(row?.remainingUsd).toBe(5); // 10 - 3 - 2
    expect(row?.callCount).toBe(4);
  });

  it("omits an absent measurement instead of reporting a zero", () => {
    const report = buildTenantBudgetReport({
      tenants,
      period: PERIOD,
      available: true,
      // a budget row with no reserved accumulator recorded
      budgets: [
        {
          category: "orchestrator",
          period: PERIOD,
          tenantId: "t-a",
          capUsd: 5,
          spentUsd: 0,
          callCount: 0,
        },
      ],
    });
    const row = report.tenants.find((t) => t.tenantId === "t-a")?.budgets[0];
    expect(row?.reservedUsd).toBeUndefined();
    expect(row?.remainingUsd).toBe(5);
  });

  it("never attributes a global budget row to a customer", () => {
    const report = buildTenantBudgetReport({
      tenants,
      period: PERIOD,
      available: true,
      budgets: [budget({ capUsd: 99 })], // no tenantId → the GLOBAL budget
    });
    expect(report.tenants.every((tenant) => tenant.budgets.length === 0)).toBe(true);
    expect(report.tenants.every((tenant) => tenant.configured === false)).toBe(true);
  });

  it("marks a tenant with no budget rows as unconfigured, not zero-spend", () => {
    const report = buildTenantBudgetReport({
      tenants,
      period: PERIOD,
      available: true,
      budgets: [budget({ tenantId: "t-a" })],
    });
    const globex = report.tenants.find((t) => t.tenantId === "t-b");
    expect(globex?.budgets).toEqual([]);
    expect(globex?.configured).toBe(false);
  });

  it("reports an unavailable store distinctly and keeps no fabricated rows", () => {
    const report = buildTenantBudgetReport({
      tenants,
      period: PERIOD,
      available: false,
      error: "Cost budget store is unavailable",
      budgets: [],
    });
    expect(report.available).toBe(false);
    expect(report.error).toMatch(/unavailable/i);
    expect(report.tenants).toEqual([]);
  });
});