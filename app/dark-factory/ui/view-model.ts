import type {
  RunMetrics,
  RunStage,
  RunStatus,
  RunStatusCount,
  RunSummary,
} from "../../../agent/lib/dark-factory/run-history";
import type { PersistedRunEvent } from "../../../agent/lib/dark-factory/run-history-store";
import {
  formatClockTime,
  formatCostUsd,
  formatDuration,
  formatRelativeTime,
} from "./format";

/** The four outcome categories the board groups runs into. */
export type RunCategory = "active" | "blocked" | "completed" | "failed";

export interface KpiTile {
  key: RunCategory;
  label: string;
  value: number;
  hint: string;
}

export interface OutcomeSegment {
  key: RunCategory;
  label: string;
  count: number;
  percent: number;
}

export interface ResourceSnapshot {
  meanLatencyMs?: number;
  totalCostUsd?: number;
  /** Runs with no recorded cost: total runs minus measured cost observations. */
  unmeasured: number;
}

export interface TableRow {
  runId: string;
  issueLabel: string;
  repo: string;
  status: RunStatus;
  category: RunCategory;
  stage: string;
  updatedLabel: string;
  attemptCount: number;
  elapsedLabel: string;
  costLabel: string;
  prUrl?: string;
}

export interface TimelineEntry {
  key: string;
  time: string;
  type: string;
  label: string;
  detail: string;
  status?: RunStatus;
}

export interface Checkpoint {
  key: string;
  label: string;
  status: string;
}

export interface MetricItem {
  key: string;
  label: string;
  value: string;
}

export interface DetailView {
  summaryTiles: MetricItem[];
  timeline: TimelineEntry[];
  checkpoints: Checkpoint[];
  metrics: MetricItem[];
}

export interface RunFilters {
  statuses?: RunStatus[];
  repo?: string;
  issue?: number;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ClientFilters {
  search?: string;
  stage?: string;
}

const CATEGORY_ORDER: RunCategory[] = [
  "completed",
  "active",
  "blocked",
  "failed",
];

const CATEGORY_META: Record<RunCategory, { label: string; hint: string }> = {
  active: { label: "ACTIVE", hint: "running now" },
  blocked: { label: "BLOCKED", hint: "needs intervention" },
  completed: { label: "COMPLETED", hint: "DoD met · PR left open" },
  failed: { label: "FAILED", hint: "terminal failures" },
};

const STAGE_ORDER: RunStage[] = [
  "trigger",
  "dispatch",
  "worker",
  "review",
  "pull-request",
  "terminal",
];

/** Human labels for the canonical lifecycle event types. */
const EVENT_LABELS: Record<string, string> = {
  "run.accepted": "Webhook accepted",
  "run.resumed": "Run resumed",
  "dispatch.started": "Worker dispatched",
  "dispatch.attempt": "Dispatch attempt",
  "worker.progress": "Worker progress",
  "worker.question": "Worker question",
  "worker.completed": "Developer complete",
  "review.round": "Review round",
  "pr.opened": "Pull request opened",
  "run.terminal": "Definition of Done met",
};

export function categorizeStatus(status: RunStatus): RunCategory {
  switch (status) {
    case "succeeded":
      return "completed";
    case "failed":
    case "aborted":
      return "failed";
    case "blocked":
      return "blocked";
    case "queued":
    case "running":
      return "active";
    default:
      return "active";
  }
}

function sumByCategory(
  statusCounts: RunStatusCount[],
): Record<RunCategory, number> {
  const sums: Record<RunCategory, number> = {
    active: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
  };
  for (const { status, count } of statusCounts) {
    sums[categorizeStatus(status)] += count;
  }
  return sums;
}

export function toKpiTiles(statusCounts: RunStatusCount[]): KpiTile[] {
  const sums = sumByCategory(statusCounts);
  return (["active", "blocked", "completed", "failed"] as RunCategory[]).map(
    (key) => ({
      key,
      label: CATEGORY_META[key].label,
      value: sums[key],
      hint: CATEGORY_META[key].hint,
    }),
  );
}

export function toOutcomeMix(statusCounts: RunStatusCount[]): {
  total: number;
  segments: OutcomeSegment[];
} {
  const sums = sumByCategory(statusCounts);
  const total = sums.active + sums.blocked + sums.completed + sums.failed;
  const segments: OutcomeSegment[] = CATEGORY_ORDER.map((key) => ({
    key,
    label: CATEGORY_META[key].label,
    count: sums[key],
    percent: 0,
  }));

  if (total > 0) {
    // Largest-remainder allocation over integer arithmetic, so the result is
    // deterministic (no floating-point tie-breaks) and the percentages sum to
    // exactly 100.
    const scaled = segments.map((segment) => segment.count * 100);
    const percents = scaled.map((value) => Math.floor(value / total));
    let remainder = 100 - percents.reduce((a, b) => a + b, 0);
    const byRemainder = scaled
      .map((value, index) => ({ index, remainder: value % total }))
      .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (const { index } of byRemainder) {
      if (remainder <= 0) break;
      percents[index] += 1;
      remainder -= 1;
    }
    segments.forEach((segment, index) => {
      segment.percent = percents[index];
    });
  }

  return { total, segments };
}

export function toResourceSnapshot(metrics: RunMetrics): ResourceSnapshot {
  const total = metrics.statusCounts.reduce((sum, c) => sum + c.count, 0);
  const latency = metrics.measured.latencyMs;
  const cost = metrics.measured.costUsd;
  return {
    meanLatencyMs:
      latency && latency.count > 0 ? latency.sum / latency.count : undefined,
    totalCostUsd: cost ? cost.sum : undefined,
    unmeasured: Math.max(0, total - (cost?.count ?? 0)),
  };
}

export function toTableRows(
  runs: RunSummary[],
  now: number | Date,
): TableRow[] {
  return runs.map((run) => ({
    runId: run.runId,
    issueLabel: `#${run.issue}`,
    repo: run.repo,
    status: run.status,
    category: categorizeStatus(run.status),
    stage: run.stage,
    updatedLabel: formatRelativeTime(run.updatedAt, now),
    attemptCount: run.attemptCount,
    elapsedLabel: formatDuration(run.startedAt, run.completedAt),
    costLabel: formatCostUsd(run.costUsd),
    prUrl: run.prUrl,
  }));
}

export function filterRows(
  rows: TableRow[],
  filters: ClientFilters,
): TableRow[] {
  const search = filters.search?.trim().toLowerCase() ?? "";
  const stage =
    filters.stage && filters.stage !== "any" ? filters.stage : undefined;
  return rows.filter((row) => {
    if (stage && row.stage !== stage) return false;
    if (!search) return true;
    const haystack = [
      row.runId,
      row.issueLabel,
      row.repo,
      row.status,
      row.stage,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(search);
  });
}

function summedMetric(
  events: PersistedRunEvent[],
  field: "findingCount" | "resolvedCount" | "acceptedCount",
): number | undefined {
  let seen = false;
  let sum = 0;
  for (const { event } of events) {
    const value = event[field];
    if (typeof value === "number") {
      seen = true;
      sum += value;
    }
  }
  return seen ? sum : undefined;
}

export function toDetailView({
  summary,
  events,
}: {
  summary: RunSummary;
  events: PersistedRunEvent[];
}): DetailView {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence);

  const timeline: TimelineEntry[] = ordered.map(({ sequence, event }) => ({
    key: event.eventId || `evt-${sequence}`,
    time: formatClockTime(event.occurredAt),
    type: event.type,
    label: EVENT_LABELS[event.type] ?? event.type,
    detail: event.status ? `${event.stage} · ${event.status}` : event.stage,
    status: event.status,
  }));

  const summaryTiles: MetricItem[] = [
    {
      key: "started",
      label: "Started",
      value: summary.startedAt ? formatClockTime(summary.startedAt) : "—",
    },
    {
      key: "elapsed",
      label: "Elapsed",
      value: formatDuration(summary.startedAt, summary.completedAt),
    },
    {
      key: "attempts",
      label: "Attempts",
      value: String(summary.attemptCount),
    },
    {
      key: "review",
      label: "Review round",
      value: String(summary.reviewCount),
    },
    {
      key: "cost",
      label: "Measured cost",
      value: formatCostUsd(summary.costUsd),
    },
  ];

  const stagesSeen = new Set(ordered.map(({ event }) => event.stage));
  const checkpoints: Checkpoint[] = STAGE_ORDER.filter((stage) =>
    stagesSeen.has(stage),
  ).map((stage) => ({ key: stage, label: stage, status: "seen" }));

  const metrics: MetricItem[] = [];
  if (summary.latencyMs !== undefined) {
    metrics.push({
      key: "latency",
      label: "Latency",
      value: `${summary.latencyMs} ms`,
    });
  }
  metrics.push({
    key: "iterations",
    label: "Iterations",
    value: String(summary.iterationCount),
  });
  metrics.push({
    key: "fixCycles",
    label: "Fix cycles",
    value: String(summary.fixCycleCount),
  });
  const findings = summedMetric(ordered, "findingCount");
  const resolved = summedMetric(ordered, "resolvedCount");
  const accepted = summedMetric(ordered, "acceptedCount");
  if (findings !== undefined)
    metrics.push({
      key: "findings",
      label: "Total findings",
      value: String(findings),
    });
  if (resolved !== undefined)
    metrics.push({
      key: "resolved",
      label: "Resolved",
      value: String(resolved),
    });
  if (accepted !== undefined)
    metrics.push({
      key: "accepted",
      label: "Accepted",
      value: String(accepted),
    });

  return { summaryTiles, timeline, checkpoints, metrics };
}

export function toQueryParams(filters: RunFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const status of filters.statuses ?? []) params.append("status", status);
  if (filters.repo) params.set("repo", filters.repo);
  if (filters.issue !== undefined) params.set("issue", String(filters.issue));
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  return params;
}