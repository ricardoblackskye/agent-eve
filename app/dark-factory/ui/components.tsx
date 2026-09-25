import type { ReactNode } from "react";
import type {
  RunTrendPoint,
  RunSummary,
} from "../../../agent/lib/dark-factory/run-history";
import { formatCostUsd, formatCount } from "./format";
import {
  categorizeStatus,
  type Checkpoint,
  type DetailView,
  type KpiTile,
  type MetricItem,
  type OutcomeSegment,
  type ResourceSnapshot,
  type TableRow,
  type TimelineEntry,
} from "./view-model";

export function StatePanel({
  state,
  message,
}: {
  state: "loading" | "error" | "empty" | "auth";
  message: string;
}): ReactNode {
  return (
    <div className={`df-state df-state-${state}`} role="status">
      {message}
    </div>
  );
}

export function StatusPill({
  category,
  label,
}: {
  category: string;
  label: string;
}): ReactNode {
  return <span className={`df-pill df-pill-${category}`}>{label}</span>;
}

export function MetricTile({
  label,
  value,
}: {
  label: string;
  value: string;
}): ReactNode {
  return (
    <div className="df-metric">
      <small>{label}</small>
      <b>{value}</b>
    </div>
  );
}

export function KpiTiles({ tiles }: { tiles: KpiTile[] }): ReactNode {
  return (
    <div className="df-kpis">
      {tiles.map((tile) => (
        <div className="df-kpi" key={tile.key}>
          <span className="df-kpi-label">{tile.label}</span>
          <span className="df-kpi-value">{formatCount(tile.value)}</span>
          <span className="df-kpi-hint">{tile.hint}</span>
        </div>
      ))}
    </div>
  );
}

export function OutcomeMix({
  total,
  segments,
}: {
  total: number;
  segments: OutcomeSegment[];
}): ReactNode {
  if (total === 0) {
    return <StatePanel state="empty" message="No outcomes yet" />;
  }
  return (
    <div className="df-mix">
      {segments.map((segment) => (
        <span className={`df-mix-item df-mix-${segment.key}`} key={segment.key}>
          <b>{`${segment.percent}% · ${segment.count}`}</b>
          {segment.label}
        </span>
      ))}
    </div>
  );
}

export function TrendChart({ points }: { points: RunTrendPoint[] }): ReactNode {
  const byDate = new Map<string, number>();
  for (const point of points) {
    byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.count);
  }
  const bars = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (bars.length === 0) {
    return <StatePanel state="empty" message="No terminal outcomes yet" />;
  }
  const max = Math.max(...bars.map(([, count]) => count), 1);
  return (
    <div className="df-trend" role="img" aria-label="Outcome trend">
      {bars.map(([date, count]) => (
        <div
          className="df-trend-bar"
          key={date}
          style={{ height: `${Math.round((count / max) * 100)}%` }}
          title={`${date}: ${count}`}
        />
      ))}
    </div>
  );
}

export function ResourceSnapshot({
  snapshot,
}: {
  snapshot: ResourceSnapshot;
}): ReactNode {
  return (
    <div className="df-snapshot">
      <div className="df-snapshot-item">
        <small>Mean latency</small>
        <b>
          {snapshot.meanLatencyMs === undefined
            ? "—"
            : `${Math.round(snapshot.meanLatencyMs)} ms`}
        </b>
      </div>
      <div className="df-snapshot-item">
        <small>Recorded cost</small>
        <b>{formatCostUsd(snapshot.totalCostUsd)}</b>
      </div>
      <div className="df-snapshot-item">
        <small>Unmeasured</small>
        <b>{`${snapshot.unmeasured} runs`}</b>
      </div>
    </div>
  );
}

export function RecentRunsList({ rows }: { rows: TableRow[] }): ReactNode {
  if (rows.length === 0) {
    return <StatePanel state="empty" message="No recent runs" />;
  }
  return (
    <div className="df-recent">
      {rows.map((row) => (
        <div className="df-recent-row" key={row.runId}>
          <span className="df-run-id">{row.runId}</span>
          <div className="df-recent-main">
            <div className="df-recent-title">{`${row.issueLabel} · ${row.repo}`}</div>
            <div className="df-recent-sub">{`${row.stage} · ${row.updatedLabel}`}</div>
          </div>
          <div className="df-recent-meta">
            <StatusPill category={row.category} label={row.status} />
            <span>{`${row.elapsedLabel} · ${row.costLabel}`}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function RunTable({
  rows,
  loading = false,
  error = null,
  selectedRunId,
  onSelect,
}: {
  rows: TableRow[];
  loading?: boolean;
  error?: string | null;
  selectedRunId?: string;
  onSelect?: (runId: string) => void;
}): ReactNode {
  if (loading) return <StatePanel state="loading" message="Loading runs…" />;
  if (error) return <StatePanel state="error" message={error} />;
  if (rows.length === 0) {
    return <StatePanel state="empty" message="No runs match these filters" />;
  }
  return (
    <table className="df-table">
      <thead>
        <tr>
          <th>Run</th>
          <th>Issue · Repo</th>
          <th>Status</th>
          <th>Stage</th>
          <th>Update</th>
          <th>Try</th>
          <th>Elapsed</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            className={`df-table-row${selectedRunId === row.runId ? " selected" : ""}`}
            key={row.runId}
            onClick={onSelect ? () => onSelect(row.runId) : undefined}
          >
            <td className="df-run-id">{row.runId}</td>
            <td>{`${row.issueLabel} · ${row.repo}`}</td>
            <td>
              <StatusPill category={row.category} label={row.status} />
            </td>
            <td>{row.stage}</td>
            <td>{row.updatedLabel}</td>
            <td>{row.attemptCount}</td>
            <td>{row.elapsedLabel}</td>
            <td>{row.costLabel}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function SelectedRunPreview({
  row,
}: {
  row: TableRow | null;
}): ReactNode {
  if (!row) {
    return <StatePanel state="empty" message="Select a run to preview it" />;
  }
  return (
    <div className="df-preview">
      <div className="df-preview-id">{`${row.runId} · ${row.status}`}</div>
      <h3>{`${row.issueLabel} · ${row.repo}`}</h3>
      <div className="df-preview-grid">
        <MetricTile label="Elapsed" value={row.elapsedLabel} />
        <MetricTile label="Attempts" value={String(row.attemptCount)} />
        <MetricTile label="Cost" value={row.costLabel} />
      </div>
      {row.prUrl ? (
        <a href={row.prUrl} target="_blank" rel="noreferrer">
          Pull request ↗
        </a>
      ) : null}
    </div>
  );
}

export function RunDetailPanel({
  summary,
  view,
}: {
  summary: RunSummary;
  view: DetailView;
}): ReactNode {
  return (
    <div className="df-detail">
      <div className="df-detail-head">
        <div className="df-detail-id">{`RUN ${summary.runId} / ${summary.stage}`}</div>
        <h2>{`${summary.repo}#${summary.issue}`}</h2>
        <StatusPill
          category={categorizeStatus(summary.status)}
          label={summary.status}
        />
      </div>
      <div className="df-metrics">
        {view.summaryTiles.map((tile) => (
          <MetricTile key={tile.key} label={tile.label} value={tile.value} />
        ))}
      </div>
      <div className="df-links">
        <a
          href={`https://github.com/${summary.repo}/issues/${summary.issue}`}
          target="_blank"
          rel="noreferrer"
        >
          {`Issue #${summary.issue} ↗`}
        </a>
        {summary.prUrl ? (
          <a href={summary.prUrl} target="_blank" rel="noreferrer">
            Pull request ↗
          </a>
        ) : null}
      </div>
    </div>
  );
}

export function EventTimeline({
  entries,
}: {
  entries: TimelineEntry[];
}): ReactNode {
  if (entries.length === 0) {
    return <StatePanel state="empty" message="No events recorded" />;
  }
  return (
    <div className="df-timeline">
      {entries.map((entry) => (
        <div className="df-event" key={entry.key}>
          <span className="df-event-time">{entry.time}</span>
          <div className="df-event-body">
            <strong>{entry.label}</strong>
            <p>{entry.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function WorkerCheckpoints({
  checkpoints,
}: {
  checkpoints: Checkpoint[];
}): ReactNode {
  if (checkpoints.length === 0) {
    return <StatePanel state="empty" message="No worker activity recorded" />;
  }
  return (
    <div className="df-checkpoints">
      {checkpoints.map((checkpoint) => (
        <span className="df-checkpoint" key={checkpoint.key}>
          {checkpoint.label}
        </span>
      ))}
    </div>
  );
}

export function MeasuredMetrics({
  metrics,
}: {
  metrics: MetricItem[];
}): ReactNode {
  if (metrics.length === 0) {
    return <StatePanel state="empty" message="No measured metrics" />;
  }
  return (
    <div className="df-metrics">
      {metrics.map((metric) => (
        <MetricTile key={metric.key} label={metric.label} value={metric.value} />
      ))}
    </div>
  );
}