// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CustomerView } from "../../app/dark-factory/ui/customer-view";
import type { RunSummary } from "../../agent/lib/dark-factory/run-history";
import type { TenantBudgetReport } from "../../agent/lib/dark-factory/tenant-budget-query";
import type { UsageReport } from "../../agent/lib/dark-factory/usage-query";

const TENANT_A = "11111111-2222-4333-8444-555555555555";

function run(runId: string): RunSummary {
  return {
    runId,
    repo: "acme/web",
    issue: 1,
    status: "succeeded",
    stage: "done",
    createdAt: "2026-10-05T10:00:00.000Z",
    updatedAt: "2026-10-05T10:00:00.000Z",
    attemptCount: 1,
    reviewCount: 0,
    iterationCount: 0,
    fixCycleCount: 0,
    tenantId: TENANT_A,
  } as unknown as RunSummary;
}

/** Deliberately unmeasured: cost is absent, so it must render as an em dash. */
const unmeasuredUsage = {
  totals: { calls: 2, unmeasured: 0 },
  unmeasured: 1,
  byTenant: [],
} as unknown as UsageReport;

function budgets(configured: boolean): TenantBudgetReport {
  return {
    period: "2026-10",
    available: true,
    tenants: [
      {
        tenantId: TENANT_A,
        name: "Acme",
        configured,
        budgets: configured
          ? [
              {
                tenantId: TENANT_A,
                name: "Acme",
                category: "orchestrator",
                capUsd: 10,
                settledUsd: 3,
                remainingUsd: 7,
                callCount: 4,
              },
            ]
          : [],
      },
    ],
  };
}

function renderView(overrides: Record<string, unknown> = {}) {
  return render(
    <CustomerView
      runs={[run("run-mine")]}
      usage={unmeasuredUsage}
      budgets={budgets(true)}
      loading={false}
      error={null}
      onRefresh={() => {}}
      {...overrides}
    />,
  );
}

describe("customer view (#215)", () => {
  it("shows the customer's own runs", () => {
    renderView();
    expect(screen.getByText("run-mine")).toBeDefined();
    expect(screen.getByText("Runs attributed to your account")).toBeDefined();
  });

  it("offers no operator affordances", () => {
    renderView();
    expect(screen.queryByText(/OPERATOR ONLY/)).toBeNull();
    expect(screen.queryByText(/LIVE CONTROL/)).toBeNull();
    expect(screen.queryByText(/LLM CALL POLICY/)).toBeNull();
  });

  it("renders an unmeasured figure as an em dash, never as zero", () => {
    renderView();
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("distinguishes 'no budget configured' from 'no spend'", () => {
    renderView({ budgets: budgets(false) });
    expect(
      screen.getByText("No budget has been set for your account."),
    ).toBeDefined();
  });

  it("surfaces an unreadable budget store distinctly", () => {
    renderView({
      budgets: {
        period: "2026-10",
        available: false,
        error: "Cost budget store is unavailable",
        tenants: [],
      } as TenantBudgetReport,
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Cost budget store is unavailable",
    );
  });

  it("says so when there are no runs rather than rendering an empty table", () => {
    renderView({ runs: [] });
    expect(screen.getByText("No runs yet.")).toBeDefined();
  });
});
