"use client";

import Link from "next/link";
import type {
  RunMetrics,
  RunSummary,
} from "../../agent/lib/dark-factory/run-history";
import {
  KpiTiles,
  OutcomeMix,
  RecentRunsList,
  ResourceSnapshot,
  StatePanel,
  TrendChart,
} from "./ui/components";
import { DEFAULT_POLL_INTERVAL_MS, useRunQuery } from "./ui/use-run-query";
import {
  toKpiTiles,
  toOutcomeMix,
  toResourceSnapshot,
  toTableRows,
} from "./ui/view-model";

export default function DarkFactoryOverviewPage() {
  const intervalMs = DEFAULT_POLL_INTERVAL_MS;
  const metrics = useRunQuery<{ metrics: RunMetrics }>(
    "/api/dark-factory/metrics",
    { intervalMs },
  );
  const runs = useRunQuery<{ runs: RunSummary[] }>(
    "/api/dark-factory/runs?limit=5",
    { intervalMs },
  );

  const authRequired =
    metrics.error === "Authentication required" ||
    runs.error === "Authentication required";
  if (authRequired) {
    return (
      <StatePanel state="auth" message="Sign in required to view the board" />
    );
  }

  const error = metrics.error ?? runs.error;
  if (error) {
    return <StatePanel state="error" message={error} />;
  }

  if (metrics.loading && !metrics.data) {
    return <StatePanel state="loading" message="Loading factory status…" />;
  }

  const statusCounts = metrics.data?.metrics.statusCounts ?? [];
  const snapshot = metrics.data
    ? toResourceSnapshot(metrics.data.metrics)
    : { unmeasured: 0 };
  const mix = toOutcomeMix(statusCounts);
  const recentRows = toTableRows(runs.data?.runs ?? [], Date.now());

  return (
    <div className="df-view">
      <div className="df-head">
        <div>
          <h1>Factory status</h1>
          <p>Persisted outcomes · current run load · recent activity</p>
        </div>
        <div className="df-actions">
          <button
            className="df-btn"
            type="button"
            onClick={() => {
              metrics.refresh();
              runs.refresh();
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      <KpiTiles tiles={toKpiTiles(statusCounts)} />

      <div className="df-grid">
        <div className="df-stack">
          <section className="df-panel">
            <div className="df-panel-head">
              <strong>OUTCOME MIX</strong>
            </div>
            <div className="df-panel-body">
              <OutcomeMix total={mix.total} segments={mix.segments} />
            </div>
          </section>
          <section className="df-panel">
            <div className="df-panel-head">
              <strong>RESOURCE SNAPSHOT</strong>
              <span>MEASURED ONLY</span>
            </div>
            <div className="df-panel-body">
              <ResourceSnapshot snapshot={snapshot} />
            </div>
          </section>
          <section className="df-panel">
            <div className="df-panel-head">
              <strong>OUTCOME TREND</strong>
              <span>TERMINAL BY DAY</span>
            </div>
            <div className="df-panel-body">
              <TrendChart points={metrics.data?.metrics.trend ?? []} />
            </div>
          </section>
        </div>
        <section className="df-panel">
          <div className="df-panel-head">
            <strong>RECENT EXECUTIONS</strong>
            <Link className="df-btn" href="/dark-factory/runs">
              ALL RUNS →
            </Link>
          </div>
          <div className="df-panel-body">
            <RecentRunsList rows={recentRows} />
          </div>
        </section>
      </div>
    </div>
  );
}
