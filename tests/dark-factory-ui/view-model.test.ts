import { describe, expect, it } from "vitest";
import {
  categorizeStatus,
  filterRows,
  toDetailView,
  toKpiTiles,
  toOutcomeMix,
  toQueryParams,
  toResourceSnapshot,
  toTableRows,
  type TableRow,
} from "../../app/dark-factory/ui/view-model";
import type {
  RunMetrics,
  RunStatusCount,
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

function event(
  overrides: Partial<PersistedRunEvent["event"]> & { sequence: number },
): PersistedRunEvent {
  const { sequence, ...rest } = overrides;
  return {
    sequence,
    event: {
      eventId: `evt-${sequence}`,
      runId: "df-1a2b",
      type: "worker.progress",
      stage: "worker",
      occurredAt: "2026-09-25T09:15:00.000Z",
      ...rest,
    },
  };
}

describe("categorizeStatus", () => {
  it("groups non-terminal statuses as active", () => {
    expect(categorizeStatus("queued")).toBe("active");
    expect(categorizeStatus("running")).toBe("active");
  });
  it("keeps blocked separate", () => {
    expect(categorizeStatus("blocked")).toBe("blocked");
  });
  it("maps succeeded to completed", () => {
    expect(categorizeStatus("succeeded")).toBe("completed");
  });
  it("groups failed and aborted as failed", () => {
    expect(categorizeStatus("failed")).toBe("failed");
    expect(categorizeStatus("aborted")).toBe("failed");
  });
});

describe("toKpiTiles", () => {
  it("sums the canonical statuses into the four categories", () => {
    const counts: RunStatusCount[] = [
      { status: "queued", count: 1 },
      { status: "running", count: 6 },
      { status: "blocked", count: 2 },
      { status: "succeeded", count: 23 },
      { status: "failed", count: 3 },
      { status: "aborted", count: 1 },
    ];
    const tiles = toKpiTiles(counts);
    expect(tiles.map((t) => [t.key, t.value])).toEqual([
      ["active", 7],
      ["blocked", 2],
      ["completed", 23],
      ["failed", 4],
    ]);
  });
});

describe("toOutcomeMix", () => {
  it("computes percentages that sum to 100 for a non-empty total", () => {
    const counts: RunStatusCount[] = [
      { status: "succeeded", count: 23 },
      { status: "running", count: 6 },
      { status: "blocked", count: 5 },
      { status: "failed", count: 6 },
    ];
    const { total, segments } = toOutcomeMix(counts);
    expect(total).toBe(40);
    expect(segments.map((s) => s.key)).toEqual([
      "completed",
      "active",
      "blocked",
      "failed",
    ]);
    expect(segments.map((s) => s.percent)).toEqual([58, 15, 12, 15]);
    expect(segments.reduce((a, s) => a + s.percent, 0)).toBe(100);
  });

  it("reports zero percentages for an empty total", () => {
    const { total, segments } = toOutcomeMix([]);
    expect(total).toBe(0);
    expect(segments.every((s) => s.percent === 0)).toBe(true);
  });
});

describe("toResourceSnapshot", () => {
  const base: RunMetrics = {
    statusCounts: [
      { status: "succeeded", count: 4 },
      { status: "running", count: 3 },
    ],
    trend: [],
    measured: {},
  };

  it("derives mean latency and total cost, and counts unmeasured runs", () => {
    const snapshot = toResourceSnapshot({
      ...base,
      measured: {
        latencyMs: { sum: 8000, count: 2 },
        costUsd: { sum: 0.42, count: 1 },
      },
    });
    expect(snapshot.meanLatencyMs).toBe(4000);
    expect(snapshot.totalCostUsd).toBe(0.42);
    expect(snapshot.unmeasured).toBe(6);
  });

  it("leaves absent measurements undefined, never zero", () => {
    const snapshot = toResourceSnapshot(base);
    expect(snapshot.meanLatencyMs).toBeUndefined();
    expect(snapshot.totalCostUsd).toBeUndefined();
    expect(snapshot.unmeasured).toBe(7);
  });
});

describe("toTableRows", () => {
  it("formats a terminal run row", () => {
    const [row] = toTableRows([summary()], NOW);
    expect(row.issueLabel).toBe("#198");
    expect(row.repo).toBe("owner/repo");
    expect(row.category).toBe("completed");
    expect(row.elapsedLabel).toBe("14m 02s");
    expect(row.costLabel).toBe("$0.42");
    expect(row.attemptCount).toBe(3);
    expect(row.prUrl).toBe("https://github.com/owner/repo/pull/202");
  });

  it("shows em dashes for an unmeasured run that never started", () => {
    const [row] = toTableRows(
      [
        summary({
          status: "queued",
          stage: "trigger",
          startedAt: undefined,
          completedAt: undefined,
          costUsd: undefined,
        }),
      ],
      NOW,
    );
    expect(row.category).toBe("active");
    expect(row.elapsedLabel).toBe("—");
    expect(row.costLabel).toBe("—");
  });
});

describe("filterRows", () => {
  const makeRows = (): TableRow[] =>
    toTableRows(
      [
        summary({ runId: "df-1a2b", issue: 198, stage: "terminal" }),
        summary({
          runId: "df-9f0e",
          issue: 201,
          repo: "owner/web",
          stage: "review",
          status: "running",
          startedAt: undefined,
          completedAt: undefined,
        }),
      ],
      NOW,
    );

  it("matches the search term across id, issue, repo and status", () => {
    const rows = makeRows();
    expect(filterRows(rows, { search: "201" }).map((r) => r.runId)).toEqual([
      "df-9f0e",
    ]);
    expect(
      filterRows(rows, { search: "owner/repo" }).map((r) => r.runId),
    ).toEqual(["df-1a2b"]);
  });

  it("filters by stage and treats 'any' as no filter", () => {
    const rows = makeRows();
    expect(filterRows(rows, { stage: "review" }).map((r) => r.runId)).toEqual([
      "df-9f0e",
    ]);
    expect(filterRows(rows, { stage: "any" })).toHaveLength(2);
  });
});

describe("toDetailView", () => {
  it("builds summary tiles, an ordered timeline, checkpoints and metrics", () => {
    const view = toDetailView({
      summary: summary(),
      events: [
        event({
          sequence: 2,
          type: "run.terminal",
          stage: "terminal",
          status: "succeeded",
          occurredAt: "2026-09-25T09:28:02.000Z",
        }),
        event({
          sequence: 1,
          type: "dispatch.started",
          stage: "dispatch",
          occurredAt: "2026-09-25T09:14:00.000Z",
        }),
      ],
    });

    expect(view.timeline.map((t) => t.key)).toEqual(["evt-1", "evt-2"]);
    expect(view.timeline[0].time).toBe("09:14:00");

    const summaryKeys = view.summaryTiles.map((t) => t.key);
    expect(summaryKeys).toContain("elapsed");
    expect(summaryKeys).toContain("attempts");
    expect(summaryKeys).toContain("review");
    expect(summaryKeys).toContain("cost");

    const checkpointKeys = view.checkpoints.map((c) => c.key);
    expect(checkpointKeys).toContain("dispatch");
    expect(checkpointKeys).toContain("terminal");

    const metricKeys = view.metrics.map((m) => m.key);
    expect(metricKeys).toContain("latency");
    expect(metricKeys).toContain("iterations");
    expect(metricKeys).toContain("fixCycles");
  });

  it("displays an unrecognized event type literally", () => {
    const view = toDetailView({
      summary: summary(),
      events: [
        {
          sequence: 1,
          event: {
            eventId: "evt-x",
            runId: "df-1a2b",
            type: "custom.thing" as never,
            stage: "worker" as never,
            occurredAt: "2026-09-25T09:16:00.000Z",
          },
        },
      ],
    });
    expect(view.timeline[0].type).toBe("custom.thing");
    expect(view.timeline[0].label).toBe("custom.thing");
  });
});

describe("toQueryParams", () => {
  it("maps supported filters to API query params", () => {
    const params = toQueryParams({
      statuses: ["succeeded", "failed"],
      repo: "owner/repo",
      issue: 12,
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-30T00:00:00.000Z",
      limit: 25,
    });
    expect(params.getAll("status")).toEqual(["succeeded", "failed"]);
    expect(params.get("repo")).toBe("owner/repo");
    expect(params.get("issue")).toBe("12");
    expect(params.get("from")).toBe("2026-09-01T00:00:00.000Z");
    expect(params.get("to")).toBe("2026-09-30T00:00:00.000Z");
    expect(params.get("limit")).toBe("25");
  });

  it("omits empty filters", () => {
    expect([...toQueryParams({}).keys()]).toEqual([]);
  });
});
