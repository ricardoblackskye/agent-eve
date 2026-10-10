import Link from "next/link";
import type { ReactNode } from "react";
import type {
  RunTrendPoint,
  RunSummary,
  TestOutcome,
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

export function PanelHead({
  title,
  badges = [],
  leading,
  action,
}: {
  title: string;
  badges?: string[];
  /**
   * Optional control rendered at the right, immediately BEFORE the badge
   * chips (e.g. a "Back to runs" link).
   */
  leading?: ReactNode;
  /**
   * Optional trailing control (e.g. an "ALL RUNS" link). Rendered after the
   * badge chips.
   */
  action?: ReactNode;
}): ReactNode {
  const hasRight = Boolean(leading || badges.length > 0 || action);
  return (
    <div className="df-panel-head">
      <strong>{title}</strong>
      {hasRight ? (
        <div className="df-head-right">
          {leading}
          {badges.length > 0 ? (
            <div className="df-chips">
              {badges.map((badge) => (
                <span className="df-chip" key={badge}>
                  {badge}
                </span>
              ))}
            </div>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  );
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
    <table className="df-table df-mix-table">
      <thead>
        <tr>
          <th scope="col">Outcome</th>
          <th scope="col">Count</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {segments.map((segment) => (
          <tr className={`df-mix-row df-mix-${segment.key}`} key={segment.key}>
            <th scope="row">{segment.label}</th>
            <td>{segment.count}</td>
            <td>{`${segment.percent}%`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TrendChart({ points }: { points: RunTrendPoint[] }): ReactNode {
  const byDate = new Map<string, number>();
  for (const point of points) {
    byDate.set(point.date, (byDate.get(point.date) ?? 0) + point.count);
  }
  const series = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (series.length === 0) {
    return <StatePanel state="empty" message="No terminal outcomes yet" />;
  }

  // A line chart, not bars: with one or two dates the old flex bars stretched to
  // fill the whole width and read as a single blue block. A viewBox makes the
  // chart scale to any number of dates, including one (drawn as a lone marker).
  const width = 320;
  const height = 90;
  const pad = 8;
  const max = Math.max(...series.map(([, count]) => count), 1);
  const step = series.length > 1 ? (width - pad * 2) / (series.length - 1) : 0;
  const coords = series.map(([, count], index) => {
    const x = series.length > 1 ? pad + index * step : width / 2;
    const y = height - pad - (count / max) * (height - pad * 2);
    return { x, y, date: series[index]?.[0] ?? "", count };
  });
  const line = coords
    .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");

  return (
    <svg
      className="df-trend-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Outcome trend"
    >
      {coords.length > 1 ? (
        <polyline className="df-trend-line" points={line} fill="none" />
      ) : null}
      {coords.map(({ x, y, date, count }) => (
        <circle className="df-trend-point" key={date} cx={x} cy={y} r={2.5}>
          <title>{`${date}: ${count}`}</title>
        </circle>
      ))}
    </svg>
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
    // A real table with a header per column (#258). The previous flex/grid row
    // layout had no column headers at all, and a grid on a row cannot express
    // column alignment. `df-table` supplies the styling the run list already uses.
    <table className="df-table df-recent-table">
      <thead>
        <tr>
          <th scope="col">Run</th>
          <th scope="col">Issue</th>
          <th scope="col">Repository</th>
          <th scope="col">Stage</th>
          <th scope="col">Updated</th>
          <th scope="col">Status</th>
          <th scope="col">Elapsed</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.runId}>
            <th scope="row" className="df-run-id">
              {row.runId}
            </th>
            <td>{row.issueLabel}</td>
            <td>{row.repo}</td>
            <td>{row.stage}</td>
            <td>{row.updatedLabel}</td>
            <td>
              <StatusPill category={row.category} label={row.status} />
            </td>
            <td>{row.elapsedLabel}</td>
            <td>{row.costLabel}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RunTable({
  rows,
  loading = false,
  error = null,
  selectedRunId,
  onSelect,
  hrefForRun,
}: {
  rows: TableRow[];
  loading?: boolean;
  error?: string | null;
  selectedRunId?: string;
  onSelect?: (runId: string) => void;
  /**
   * When given, each run id renders as a link to its detail route — so the row
   * is reachable by keyboard as well as by click.
   */
  hrefForRun?: (runId: string) => string;
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
            <td className="df-run-id">
              {hrefForRun ? (
                <Link className="df-run-id" href={hrefForRun(row.runId)}>
                  {row.runId}
                </Link>
              ) : (
                row.runId
              )}
            </td>
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
            {entry.commentUrl ? (
              <a
                className="df-event-comment"
                href={entry.commentUrl}
                target="_blank"
                rel="noreferrer"
              >
                View question on GitHub ↗
              </a>
            ) : null}
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
        <MetricTile
          key={metric.key}
          label={metric.label}
          value={metric.value}
        />
      ))}
    </div>
  );
}

export function OutcomeArtifacts({ prUrl }: { prUrl?: string }): ReactNode {
  return (
    <section className="df-panel">
      <PanelHead title="OUTCOME" badges={["ARTIFACTS"]} />
      <div className="df-panel-body">
        {prUrl ? (
          <a
            className="df-outcome-link"
            href={prUrl}
            target="_blank"
            rel="noreferrer"
          >
            {"Pull request — agent outcome ↗"}
          </a>
        ) : (
          <StatePanel state="empty" message="No PR opened yet" />
        )}
      </div>
    </section>
  );
}


export function RunDiffPanel({ gitDiff }: { gitDiff?: string }): ReactNode {
  if (!gitDiff) {
    return (
      <section className="df-panel">
        <PanelHead title="RUN DIFF" badges={["GIT"]} />
        <div className="df-panel-body">
          <StatePanel state="empty" message="No diff captured" />
        </div>
      </section>
    );
  }
  const lines = gitDiff.split("\n");
  return (
    <section className="df-panel">
      <PanelHead title="RUN DIFF" badges={["GIT", "CAPTURED"]} />
      <div className="df-panel-body">
        <pre className="df-diff" data-testid="run-diff">
          {lines.map((line, index) => {
            const cls =
              /^(diff |index |@@ |--- |\+\+\+ )/.test(line)
                ? "df-diff-meta"
                : line.startsWith("+")
                  ? "df-diff-add"
                  : line.startsWith("-")
                    ? "df-diff-del"
                    : "df-diff-ctx";
            return (
              <span key={index} className={cls}>
                {line}
                {"\n"}
              </span>
            );
          })}
        </pre>
      </div>
    </section>
  );
}

export function TestOutputPanel({
  testResults,
}: {
  testResults?: TestOutcome[];
}): ReactNode {
  if (!testResults || testResults.length === 0) {
    return (
      <section className="df-panel">
        <PanelHead title="TEST OUTPUT" badges={["TESTER"]} />
        <div className="df-panel-body">
          <StatePanel state="empty" message="No test output captured" />
        </div>
      </section>
    );
  }
  const passed = testResults.filter((t) => t.passed).length;
  const failed = testResults.length - passed;
  return (
    <section className="df-panel">
      <PanelHead title="TEST OUTPUT" badges={["TESTER", "CAPTURED"]} />
      <div className="df-panel-body">
        <p className="df-test-summary" data-testid="test-output-summary">
          <span className="df-test-pass">{passed} passed</span>
          <span className="df-test-sep"> · </span>
          <span className="df-test-fail">{failed} failed</span>
        </p>
        <ul className="df-test-list">
          {testResults.map((t, index) => (
            <li
              key={`${t.testFile}:${t.testCaseName}:${index}`}
              className={t.passed ? "df-test-pass" : "df-test-fail"}
              data-testid={t.passed ? "test-passed" : "test-failed"}
            >
              <span aria-hidden="true">{t.passed ? "✓" : "✗"}</span>{" "}
              <span className="df-test-file">{t.testFile}</span>
              <span className="df-test-sep"> › </span>
              <span className="df-test-name">{t.testCaseName}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
