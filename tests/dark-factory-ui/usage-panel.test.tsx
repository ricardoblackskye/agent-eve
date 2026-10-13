// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsagePanel } from "../../app/dark-factory/ui/usage-panel";
import type { UsageReport } from "../../agent/lib/dark-factory/usage-query";

const report: UsageReport = {
  totals: { calls: 3, costUsd: 1.25, tokensIn: 100, tokensOut: 50 },
  byModel: [{ model: "deepseek/deepseek-chat", calls: 2, costUsd: 1 }],
  byTaskType: [{ taskType: "developer", calls: 2, costUsd: 1 }],
  byDay: [{ date: "2026-09-30", calls: 3, costUsd: 1.25 }],
  byRun: [{ runId: "run-1", calls: 3, costUsd: 1.25 }],
  byTenant: [],
  unassigned: { calls: 0, unmeasured: 0 },
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
          byTaskType: [],
          byDay: [],
          byRun: [],
          byTenant: [],
          unassigned: { calls: 0, unmeasured: 0 },
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

describe("UsagePanel — tokens, duration and task type (#277 T2)", () => {
  const detailed: UsageReport = {
    totals: {
      calls: 2,
      costUsd: 0.6,
      tokensIn: 30,
      tokensOut: 15,
      durationMs: 900,
    },
    byModel: [
      {
        model: "a/one",
        calls: 1,
        costUsd: 0.5,
        tokensIn: 20,
        tokensOut: 10,
        durationMs: 800,
      },
      { model: "b/two", calls: 1 },
    ],
    byDay: [{ date: "2026-10-01", calls: 2, costUsd: 0.6 }],
    byRun: [{ runId: "r1", calls: 2, costUsd: 0.6 }],
    byTaskType: [
      {
        taskType: "developer",
        calls: 1,
        costUsd: 0.5,
        tokensIn: 20,
        tokensOut: 10,
        durationMs: 800,
      },
      { taskType: "tester", calls: 1 },
    ],
    byTenant: [],
    unassigned: { calls: 0, unmeasured: 0 },
    unmeasured: 0,
  };

  it("shows tokens and duration against each model, and a dash where unmeasured", () => {
    const { container } = render(
      <UsagePanel
        report={detailed}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    const modelTable = [...container.querySelectorAll("table")].find((table) =>
      (table.querySelector("caption")?.textContent ?? "").includes("By model"),
    );
    expect(modelTable, "the by-model table should exist").toBeTruthy();

    const headings = [...modelTable!.querySelectorAll("thead th")].map(
      (th) => th.textContent,
    );
    expect(headings).toEqual([
      "Model",
      "Calls",
      "Tokens in",
      "Tokens out",
      "Duration",
      "Cost",
    ]);

    const rows = [...modelTable!.querySelectorAll("tbody tr")].map(
      (tr) => tr.textContent,
    );
    expect(rows[0]).toContain("20");
    expect(rows[0]).toContain("800");
    // The unmeasured model must not read as zero tokens / zero duration.
    expect(rows[1]).toContain("—");
  });

  it("renders a breakdown by task type", () => {
    const { container } = render(
      <UsagePanel
        report={detailed}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    const table = [...container.querySelectorAll("table")].find((candidate) =>
      (candidate.querySelector("caption")?.textContent ?? "")
        .toLowerCase()
        .includes("task type"),
    );
    expect(table, "a by-task-type table should exist").toBeTruthy();
    expect(table!.textContent).toContain("developer");
    expect(table!.textContent).toContain("tester");
  });
});
