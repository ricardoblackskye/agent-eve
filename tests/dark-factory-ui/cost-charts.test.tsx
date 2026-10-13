// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CostBudgetsPanel } from "../../app/dark-factory/ui/cost-budgets-panel";
import { BarChart, CostTrendChart } from "../../app/dark-factory/ui/components";
import { TenantUsagePanel } from "../../app/dark-factory/ui/tenant-usage-panel";
import { UsagePanel } from "../../app/dark-factory/ui/usage-panel";
import type { CostBudgetReport } from "../../agent/lib/dark-factory/cost-budget-query";
import type { UsageReport } from "../../agent/lib/dark-factory/usage-query";

/**
 * #277 T3 — the charts. Each one answers a stated question, reuses the existing inline-SVG idiom
 * (`TrendChart`), and adds no dependency.
 *
 * The rule every chart here must respect: a value nobody measured is ABSENT, never plotted at zero.
 * A zero on a chart is a claim about the world ("this cost nothing"); an absent point is the truth.
 */
const usage: UsageReport = {
  totals: { calls: 3, costUsd: 3, tokensIn: 10, tokensOut: 5 },
  byModel: [
    { model: "a/one", calls: 2, costUsd: 2 },
    { model: "b/two", calls: 1 }, // unmeasured cost — must not become a $0.00 bar
  ],
  byTaskType: [{ taskType: "developer", calls: 3, costUsd: 3 }],
  byDay: [
    { date: "2026-10-01", calls: 2, costUsd: 2 },
    { date: "2026-10-02", calls: 1 }, // unmeasured day — must not become a zero point
  ],
  byRun: [{ runId: "r1", calls: 3, costUsd: 3 }],
  byTenant: [],
  unassigned: { calls: 0, unmeasured: 0 },
  unmeasured: 0,
};

describe("BarChart (#277 T3)", () => {
  it("draws one bar per entry and labels each one", () => {
    const { container } = render(
      <BarChart
        label="Cost by model"
        bars={[
          { key: "a", label: "a/one", value: 2, display: "$2.00" },
          { key: "b", label: "b/two", value: 1, display: "$1.00" },
        ]}
      />,
    );

    expect(container.querySelectorAll("rect.df-bar").length).toBe(2);
    expect(container.querySelector("svg")?.getAttribute("role")).toBe("img");
    expect(container.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "Cost by model",
    );
    expect(container.textContent).toContain("$2.00");
  });

  it("shows an explicit empty state rather than an empty frame", () => {
    const { container } = render(<BarChart label="Cost by model" bars={[]} />);

    expect(container.querySelectorAll("rect.df-bar").length).toBe(0);
    expect(container.textContent).toMatch(/nothing measured/i);
  });
});

describe("CostTrendChart (#277 T3)", () => {
  it("plots only measured days, so an unmeasured day is absent rather than zero", () => {
    const { container } = render(
      <CostTrendChart
        points={[
          { date: "2026-10-01", costUsd: 2 },
          { date: "2026-10-02" },
          { date: "2026-10-03", costUsd: 1 },
        ]}
      />,
    );

    expect(container.querySelectorAll("circle.df-cost-point").length).toBe(2);
    expect(container.textContent).not.toContain("2026-10-02");
    expect(container.textContent).not.toContain("$0.00");
  });

  it("shows an empty state when no day carried a measurement", () => {
    const { container } = render(
      <CostTrendChart points={[{ date: "2026-10-02" }]} />,
    );

    expect(container.textContent).toMatch(/nothing measured/i);
  });
});

describe("charts in the operator panels (#277 T3)", () => {
  it("the usage panel charts daily cost and cost by model, excluding unmeasured entries", () => {
    const { container } = render(
      <UsagePanel
        report={usage}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    const labels = [...container.querySelectorAll("svg")].map((svg) =>
      svg.getAttribute("aria-label"),
    );
    expect(labels).toContain("Daily cost");
    expect(labels).toContain("Cost by model");

    const modelChart = [...container.querySelectorAll("svg")].find(
      (svg) => svg.getAttribute("aria-label") === "Cost by model",
    );
    // a/one is measured; b/two has no measured cost, so it is not a bar
    expect(modelChart?.querySelectorAll("rect.df-bar").length).toBe(1);
    expect(modelChart?.textContent).toContain("a/one");
    expect(modelChart?.textContent).not.toContain("b/two");
  });

  it("the cost-budget panel burns down committed spend against the cap", () => {
    const report: CostBudgetReport = {
      period: "2026-10",
      budgets: [
        {
          category: "orchestrator",
          period: "2026-10",
          capUsd: 10,
          spentUsd: 4,
          reservedUsd: 2,
          remainingUsd: 4,
          callCount: 7,
        },
        null, // unconfigured: no cap to burn down against
      ],
      totals: {
        capUsd: 10,
        spentUsd: 4,
        reservedUsd: 2,
        remainingUsd: 4,
        callCount: 7,
      },
    };
    const { container } = render(
      <CostBudgetsPanel
        report={report}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    const chart = [...container.querySelectorAll("svg")].find(
      (svg) => svg.getAttribute("aria-label") === "Budget burn down",
    );
    expect(chart, "a burn-down chart should exist").toBeTruthy();
    expect(chart?.querySelectorAll("rect.df-bar").length).toBe(1);
    // spent + reserved committed against the cap, named in the tooltip
    expect(chart?.textContent).toContain("orchestrator");
  });

  it("the tenant panel charts spend per customer", () => {
    const { container } = render(
      <TenantUsagePanel
        report={{
          ...usage,
          byTenant: [{ tenantId: "t-a", calls: 3, costUsd: 3, unmeasured: 0 }],
        }}
        tenants={[]}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    const chart = [...container.querySelectorAll("svg")].find(
      (svg) => svg.getAttribute("aria-label") === "Spend by tenant",
    );
    expect(chart, "a per-tenant spend chart should exist").toBeTruthy();
    expect(chart?.querySelectorAll("rect.df-bar").length).toBe(1);
  });
});
