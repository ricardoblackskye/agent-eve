// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsagePanel } from "../../app/dark-factory/ui/usage-panel";
import type { UsageReport } from "../../agent/lib/dark-factory/usage-query";

const report: UsageReport = {
  totals: { calls: 3, costUsd: 1.25, tokensIn: 100, tokensOut: 50 },
  byModel: [{ model: "deepseek/deepseek-chat", calls: 2, costUsd: 1 }],
  byDay: [{ date: "2026-09-30", calls: 3, costUsd: 1.25 }],
  byRun: [{ runId: "run-1", calls: 3, costUsd: 1.25 }],
  unmeasured: 1,
};

describe("UsagePanel", () => {
  it("renders the totals and the per-model breakdown", () => {
    render(
      <UsagePanel
        report={report}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getAllByText("$1.25").length).toBeGreaterThan(0);
    expect(screen.getByText("deepseek/deepseek-chat")).toBeTruthy();
  });

  it("renders an unmeasured value as an em dash, never as zero", () => {
    render(
      <UsagePanel
        report={{ ...report, totals: { calls: 1 } }}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("surfaces the error and refreshes on demand", () => {
    const onRefresh = vi.fn();
    render(
      <UsagePanel
        report={null}
        loading={false}
        error="ledger unavailable"
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe("ledger unavailable");
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when nothing has been recorded", () => {
    render(
      <UsagePanel
        report={{
          totals: { calls: 0 },
          byModel: [],
          byDay: [],
          byRun: [],
          unmeasured: 0,
        }}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText(/no usage recorded/i)).toBeTruthy();
  });

  it("does not render a table while the first load is still in flight", () => {
    render(
      <UsagePanel report={null} loading error={null} onRefresh={vi.fn()} />,
    );

    expect(screen.getByText(/loading/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});