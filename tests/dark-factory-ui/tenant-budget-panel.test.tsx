// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TenantBudgetPanel } from "../../app/dark-factory/ui/tenant-budget-panel";
import type { TenantBudgetReport } from "../../agent/lib/dark-factory/tenant-budget-query";

const report: TenantBudgetReport = {
  period: "2026-10",
  available: true,
  tenants: [
    {
      tenantId: "t-a",
      name: "Acme",
      configured: true,
      budgets: [
        {
          tenantId: "t-a",
          name: "Acme",
          category: "orchestrator",
          capUsd: 10,
          settledUsd: 3,
          reservedUsd: 2,
          remainingUsd: 5,
          callCount: 4,
        },
      ],
    },
    { tenantId: "t-b", name: "Globex", configured: false, budgets: [] },
  ],
};

describe("TenantBudgetPanel (#231)", () => {
  it("renders a row per tenant budget with the honesty em dash for absent values", () => {
    const { container } = render(
      <TenantBudgetPanel report={report} loading={false} error={null} onRefresh={() => {}} />,
    );
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).toContain("$10.00");
    expect(container.textContent).toContain("$5.00");
    // a tenant with no budget is distinct from one spending zero
    expect(container.textContent).toMatch(/no budget/i);
    expect(container.querySelectorAll(".df-budget-row").length).toBeGreaterThan(0);
  });

  it("reports an unavailable store as its own state, not as no spend", () => {
    const { container } = render(
      <TenantBudgetPanel
        report={{ period: "2026-10", available: false, error: "Cost budget store is unavailable", tenants: [] }}
        loading={false}
        error={null}
        onRefresh={() => {}}
      />,
    );
    expect(container.textContent).toMatch(/unavailable/i);
    expect(container.textContent).not.toContain("No spend");
  });
});