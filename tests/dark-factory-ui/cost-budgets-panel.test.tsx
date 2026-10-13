// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CostBudgetsPanel } from "../../app/dark-factory/ui/cost-budgets-panel";
import type { CostBudgetReport } from "../../agent/lib/dark-factory/cost-budget-query";

/**
 * #277 — the operator cost view was the only dashboard panel with NO test.
 *
 * Why: its siblings are presentational (`XPanel` takes report/loading/error/onRefresh) with a
 * separate `XPanelContainer` that fetches, so they can be rendered directly. `CostBudgetsPanel`
 * fetched internally, so it could not be rendered without mocking the hook. This test is written
 * against the interface that SHOULD exist — which is why it fails first.
 */
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
    null, // developer: no budget row exists — a GAP, not a zero
    {
      category: "tester",
      period: "2026-10",
      capUsd: 5,
      spentUsd: 1,
      reservedUsd: 0,
      remainingUsd: 4,
      callCount: 2,
    },
  ],
  totals: { capUsd: 15, spentUsd: 5, reservedUsd: 2, remainingUsd: 8, callCount: 9 },
};

describe("CostBudgetsPanel (#277)", () => {
  it("renders a row per canonical category with reserved kept distinct from spent", () => {
    const { container } = render(
      <CostBudgetsPanel report={report} loading={false} error={null} onRefresh={() => {}} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("orchestrator");
    expect(text).toContain("$10.00"); // cap
    expect(text).toContain("$4.00"); // spent
    expect(text).toContain("$2.00"); // reserved — a distinct quantity, not blended into spent
    expect(text).toContain("$8.00"); // remaining (totals)
  });

  it("shows a category with no budget as the honesty em dash, never as $0.00", () => {
    const { container } = render(
      <CostBudgetsPanel report={report} loading={false} error={null} onRefresh={() => {}} />,
    );
    const rows = [...container.querySelectorAll("tbody tr")];
    const gapRow = rows.find((row) => (row.textContent ?? "").startsWith("developer"));
    expect(gapRow, "developer row should exist as an explicit gap").toBeTruthy();
    expect(gapRow?.textContent).toContain("—");
    // The whole point: an unconfigured category must not look like one that spent nothing.
    expect(gapRow?.textContent).not.toContain("$0.00");
  });

  it("labels every row from the view's OWN category, not from its position", () => {
    // The view carries `category`; labelling positionally would mislabel any other order.
    const shuffled: CostBudgetReport = {
      ...report,
      budgets: [
        {
          category: "pr-review",
          period: "2026-10",
          capUsd: 3,
          spentUsd: 1,
          reservedUsd: 0,
          remainingUsd: 2,
          callCount: 1,
        },
        {
          category: "orchestrator",
          period: "2026-10",
          capUsd: 10,
          spentUsd: 4,
          reservedUsd: 2,
          remainingUsd: 4,
          callCount: 7,
        },
      ],
    };
    const { container } = render(
      <CostBudgetsPanel report={shuffled} loading={false} error={null} onRefresh={() => {}} />,
    );
    const labels = [...container.querySelectorAll("tbody th")].map((th) => th.textContent);
    expect(labels).toEqual(["pr-review", "orchestrator"]);
  });

  it("reports loading, error and the empty state distinctly", () => {
    const loading = render(
      <CostBudgetsPanel report={null} loading error={null} onRefresh={() => {}} />,
    );
    expect(loading.container.textContent).toMatch(/loading/i);

    const errored = render(
      <CostBudgetsPanel report={null} loading={false} error="Cost budget store is unavailable" onRefresh={() => {}} />,
    );
    expect(errored.container.querySelector("[role=alert]")?.textContent).toMatch(/unavailable/i);

    const empty = render(
      <CostBudgetsPanel report={null} loading={false} error={null} onRefresh={() => {}} />,
    );
    expect(empty.container.textContent).toMatch(/no budgets configured/i);
  });
});
