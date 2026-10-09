// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  EventTimeline,
  KpiTiles,
  MeasuredMetrics,
  OutcomeArtifacts,
  OutcomeMix,
  PanelHead,
  RecentRunsList,
  ResourceSnapshot,
  RunDetailPanel,
  RunDiffPanel,
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

  it("links each run id to its detail route when hrefForRun is given", () => {
    const { container } = render(
      <RunTable
        rows={rows}
        loading={false}
        error={null}
        hrefForRun={(runId) => `/dark-factory/runs/${runId}`}
      />,
    );
    const link = container.querySelector("a.df-run-id");
    expect(link?.getAttribute("href")).toBe("/dark-factory/runs/df-active");
    expect(container.querySelectorAll("a.df-run-id")).toHaveLength(3);
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

  it("renders the outcome mix as a padded table", () => {
    const { total, segments } = toOutcomeMix([
      { status: "succeeded", count: 23 },
      { status: "running", count: 6 },
      { status: "blocked", count: 5 },
      { status: "failed", count: 6 },
    ]);
    const { container } = render(
      <OutcomeMix total={total} segments={segments} />,
    );
    expect(container.querySelector("table.df-mix-table")).toBeTruthy();
    expect(container.querySelectorAll(".df-mix-row")).toHaveLength(4);
    expect(container.textContent).toContain("58%");
  });

  it("renders the trend chart, aggregating by date, and an empty state", () => {
    const points = [
      { date: "2026-09-24", outcome: "succeeded" as const, count: 2 },
      { date: "2026-09-24", outcome: "failed" as const, count: 1 },
      { date: "2026-09-25", outcome: "succeeded" as const, count: 3 },
    ];
    const { container } = render(<TrendChart points={points} />);
    // Two distinct dates -> two markers joined by a line.
    expect(container.querySelectorAll(".df-trend-point")).toHaveLength(2);
    expect(container.querySelectorAll(".df-trend-line")).toHaveLength(1);
    expect(container.querySelector("svg")?.getAttribute("role")).toBe("img");

    // A single date is a lone marker, never a full-width block.
    const single = render(
      <TrendChart
        points={[
          { date: "2026-09-24", outcome: "succeeded" as const, count: 2 },
        ]}
      />,
    );
    expect(single.container.querySelectorAll(".df-trend-point")).toHaveLength(
      1,
    );
    expect(single.container.querySelector(".df-trend-line")).toBeNull();

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
    // A real table with a header per column (#258).
    expect(container.querySelectorAll("table tbody tr")).toHaveLength(1);
    expect(
      [...container.querySelectorAll("thead th")].map((th) => th.textContent),
    ).toEqual([
      "Run",
      "Issue",
      "Repository",
      "Stage",
      "Updated",
      "Status",
      "Elapsed",
      "Cost",
    ]);
    const empty = render(<RecentRunsList rows={[]} />);
    expect(empty.container.querySelector(".df-state-empty")).toBeTruthy();
  });
});

describe("panel head", () => {
  it("renders role badges as separate, spaced chips", () => {
    const { container } = render(
      <PanelHead title="LLM USAGE" badges={["OPERATOR ONLY", "READ ONLY"]} />,
    );
    expect(container.querySelector(".df-panel-head strong")?.textContent).toBe(
      "LLM USAGE",
    );
    const chips = [...container.querySelectorAll(".df-chip")];
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "OPERATOR ONLY",
      "READ ONLY",
    ]);
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

describe("OutcomeArtifacts", () => {
  it("renders the PR link when the run has one", () => {
    const { container } = render(
      <OutcomeArtifacts prUrl="https://github.com/owner/repo/pull/9" />,
    );
    expect(container.textContent).toContain("Pull request");
    expect(
      container.querySelector('a[href="https://github.com/owner/repo/pull/9"]'),
    ).not.toBeNull();
  });

  it("renders an empty state when there is no PR", () => {
    const { container } = render(<OutcomeArtifacts prUrl={undefined} />);
    expect(container.querySelector(".df-state-empty")).toBeTruthy();
  });
});

describe("RunDiffPanel", () => {
  it("renders the captured diff in a scrollable block", () => {
    const { container } = render(
      <RunDiffPanel gitDiff={"diff --git a/foo.ts b/foo.ts\n-const a = 1;\n+const a = 2;"} />,
    );
    const block = container.querySelector(".df-diff");
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("const a = 1;");
    expect(block?.textContent).toContain("const a = 2;");
  });

  it("color-codes added and removed lines", () => {
    const { container } = render(
      <RunDiffPanel gitDiff={"-removed line\n+added line"} />,
    );
    expect(container.querySelector(".df-diff-add")).toBeTruthy();
    expect(container.querySelector(".df-diff-del")).toBeTruthy();
  });

  it("renders an empty state when no diff was captured", () => {
    const { container } = render(<RunDiffPanel gitDiff={undefined} />);
    expect(container.querySelector(".df-diff")).toBeNull();
    expect(container.querySelector(".df-state-empty")).toBeTruthy();
  });
});
