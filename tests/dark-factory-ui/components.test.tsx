// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  EventTimeline,
  KpiTiles,
  MeasuredMetrics,
  OutcomeMix,
  RecentRunsList,
  ResourceSnapshot,
  RunDetailPanel,
  RunTable,
  StatePanel,
  StatusPill,
  TrendChart,
  WorkerCheckpoints,
} from "../../app/dark-factory/ui/components";
import {
  toDetailView,
  toKpiTiles,
  toOutcomeMix,
  toResourceSnapshot,
  toTableRows,
  type TableRow,
} from "../../app/dark-factory/ui/view-model";
import type {
  RunMetrics,
  RunSummary,
} from "../../agent/lib/dark-factory/run-history";
import type { PersistedRunEvent } from "../../agent/lib/dark-factory/run-history-store";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "df-1a2b",
    repo: "owner/repo",
    issue: 198,
    status: "succeeded",
    stage: "terminal",
    createdAt: "2026-09-25T09:14:00.000Z",
    updatedAt: "2026-09-25T09:28:02.000Z",
    startedAt: "2026-09-25T09:14:00.000Z",
    completedAt: "2026-09-25T09:28:02.000Z",
    attemptCount: 3,
    reviewCount: 2,
    iterationCount: 3,
    fixCycleCount: 1,
    latencyMs: 1917,
    costUsd: 0.42,
    prUrl: "https://github.com/owner/repo/pull/202",
    ...overrides,
  };
}

describe("state matrix", () => {
  it("renders the loading state", () => {
    const { container } = render(<RunTable rows={[]} loading error={null} />);
    expect(container.querySelector(".df-state-loading")).toBeTruthy();
  });

  it("renders the error state with the message", () => {
    const { container } = render(
      <RunTable
        rows={[]}
        loading={false}
        error="Request failed with status 503"
      />,
    );
    expect(container.querySelector(".df-state-error")?.textContent).toContain(
      "503",
    );
  });

  it("renders the empty state when there are no rows", () => {
    const { container } = render(
      <RunTable rows={[]} loading={false} error={null} />,
    );
    expect(container.querySelector(".df-state-empty")).toBeTruthy();
  });

  it("renders the auth state", () => {
    const { container } = render(
      <StatePanel state="auth" message="Sign in required" />,
    );
    expect(container.querySelector(".df-state-auth")?.textContent).toContain(
      "Sign in required",
    );
  });
});

describe("run states", () => {
  const rows = toTableRows(
    [
      summary({ runId: "df-active", status: "running", stage: "worker" }),
      summary({ runId: "df-blocked", status: "blocked", stage: "review" }),
      summary({ runId: "df-done", status: "succeeded" }),
    ],
    NOW,
  );

  it("renders active, blocked and terminal pills by category", () => {
    const { container } = render(
      <RunTable rows={rows} loading={false} error={null} />,
    );
    expect(container.querySelector(".df-pill-active")).toBeTruthy();
    expect(container.querySelector(".df-pill-blocked")).toBeTruthy();
    expect(container.querySelector(".df-pill-completed")).toBeTruthy();
  });

  it("renders a failed pill", () => {
    const { container } = render(
      <StatusPill category="failed" label="failed" />,
    );
    expect(container.querySelector(".df-pill-failed")).toBeTruthy();
  });

  it("renders one table row per run", () => {
    const { container } = render(
      <RunTable rows={rows} loading={false} error={null} />,
    );
    expect(container.querySelectorAll(".df-table-row")).toHaveLength(3);
  });
});

describe("overview components", () => {
  it("renders four KPI tiles", () => {
    const tiles = toKpiTiles([
      { status: "running", count: 7 },
      { status: "blocked", count: 2 },
      { status: "succeeded", count: 23 },
      { status: "failed", count: 4 },
    ]);
    const { container } = render(<KpiTiles tiles={tiles} />);
    expect(container.querySelectorAll(".df-kpi")).toHaveLength(4);
    const values = [...container.querySelectorAll(".df-kpi-value")].map(
      (el) => el.textContent,
    );
    expect(values).toContain("07");
  });

  it("renders the outcome mix legend with percentages", () => {
    const { total, segments } = toOutcomeMix([
      { status: "succeeded", count: 23 },
      { status: "running", count: 6 },
      { status: "blocked", count: 5 },
      { status: "failed", count: 6 },
    ]);
    const { container } = render(
      <OutcomeMix total={total} segments={segments} />,
    );
    expect(container.querySelectorAll(".df-mix-item")).toHaveLength(4);
    expect(container.textContent).toContain("58%");
  });

  it("renders the trend chart, aggregating by date, and an empty state", () => {
    const points = [
      { date: "2026-09-24", outcome: "succeeded" as const, count: 2 },
      { date: "2026-09-24", outcome: "failed" as const, count: 1 },
      { date: "2026-09-25", outcome: "succeeded" as const, count: 3 },
    ];
    const { container } = render(<TrendChart points={points} />);
    expect(container.querySelectorAll(".df-trend-bar")).toHaveLength(2);

    const empty = render(<TrendChart points={[]} />);
    expect(empty.container.querySelector(".df-state-empty")).toBeTruthy();
  });

  it("renders the resource snapshot with em dashes for absent measurements", () => {
    const metrics: RunMetrics = {
      statusCounts: [{ status: "succeeded", count: 3 }],
      trend: [],
      measured: {},
    };
    const { container } = render(
      <ResourceSnapshot snapshot={toResourceSnapshot(metrics)} />,
    );
    expect(container.textContent).toContain("3 runs");
    expect(container.textContent).toContain("—");
  });

  it("renders recent runs and an empty state", () => {
    const rows = toTableRows([summary()], NOW);
    const { container } = render(<RecentRunsList rows={rows} />);
    expect(container.querySelectorAll(".df-recent-row")).toHaveLength(1);
    const empty = render(<RecentRunsList rows={[]} />);
    expect(empty.container.querySelector(".df-state-empty")).toBeTruthy();
  });
});

describe("detail components", () => {
  const events: PersistedRunEvent[] = [
    {
      sequence: 1,
      event: {
        eventId: "evt-1",
        runId: "df-1a2b",
        type: "dispatch.started",
        stage: "dispatch",
        occurredAt: "2026-09-25T09:14:00.000Z",
      },
    },
    {
      sequence: 2,
      event: {
        eventId: "evt-2",
        runId: "df-1a2b",
        type: "run.terminal",
        stage: "terminal",
        occurredAt: "2026-09-25T09:28:02.000Z",
        status: "succeeded",
        findingCount: 3,
        resolvedCount: 2,
        acceptedCount: 1,
      },
    },
  ];

  it("renders the detail panel tiles and issue/PR links", () => {
    const view = toDetailView({ summary: summary(), events });
    const { container } = render(
      <RunDetailPanel summary={summary()} view={view} />,
    );
    expect(container.querySelectorAll(".df-metric").length).toBeGreaterThan(0);
    const links = [...container.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).toContain("https://github.com/owner/repo/pull/202");
    expect(links.some((href) => href?.includes("/issues/198"))).toBe(true);
  });

  it("renders the event timeline in order", () => {
    const view = toDetailView({ summary: summary(), events });
    const { container } = render(<EventTimeline entries={view.timeline} />);
    const items = [...container.querySelectorAll(".df-event")];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Worker dispatched");
  });

  it("renders worker checkpoints", () => {
    const view = toDetailView({ summary: summary(), events });
    const { container } = render(
      <WorkerCheckpoints checkpoints={view.checkpoints} />,
    );
    expect(container.querySelectorAll(".df-checkpoint").length).toBeGreaterThan(
      0,
    );
  });

  it("renders measured metrics including findings", () => {
    const view = toDetailView({ summary: summary(), events });
    const { container } = render(<MeasuredMetrics metrics={view.metrics} />);
    expect(container.textContent).toContain("Total findings");
    expect(container.textContent).toContain("Fix cycles");
  });
});
