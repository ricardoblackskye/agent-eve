"use client";

import { useParams } from "next/navigation";
import type { RunSummary } from "../../../../agent/lib/dark-factory/run-history";
import type { PersistedRunEvent } from "../../../../agent/lib/dark-factory/run-history-store";
import {
  EventTimeline,
  MeasuredMetrics,
  RunDetailPanel,
  StatePanel,
  WorkerCheckpoints,
} from "../../ui/components";
import { DEFAULT_POLL_INTERVAL_MS, useRunQuery } from "../../ui/use-run-query";
import { toDetailView } from "../../ui/view-model";

export default function DarkFactoryRunDetailPage() {
  const params = useParams<{ runId: string }>();
  const runId = typeof params?.runId === "string" ? params.runId : "";
  const run = useRunQuery<{
    summary: RunSummary;
    events: PersistedRunEvent[];
  }>(runId ? `/api/dark-factory/runs/${encodeURIComponent(runId)}` : null, {
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  });

  if (run.error === "Authentication required") {
    return (
      <StatePanel state="auth" message="Sign in required to view the board" />
    );
  }
  if (run.error && run.error.includes("404")) {
    return <StatePanel state="empty" message="Run not found" />;
  }
  if (run.error) {
    return <StatePanel state="error" message={run.error} />;
  }
  if (run.loading && !run.data) {
    return <StatePanel state="loading" message="Loading run…" />;
  }
  if (!run.data) {
    return <StatePanel state="empty" message="Run not found" />;
  }

  const view = toDetailView({
    summary: run.data.summary,
    events: run.data.events,
  });

  return (
    <div className="df-view">
      <RunDetailPanel summary={run.data.summary} view={view} />
      <div className="df-detail-grid">
        <section className="df-panel">
          <div className="df-panel-head">
            <strong>EVENT STREAM</strong>
            <span>OLDEST → NEWEST</span>
          </div>
          <div className="df-panel-body">
            <EventTimeline entries={view.timeline} />
          </div>
        </section>
        <div className="df-stack">
          <section className="df-panel">
            <div className="df-panel-head">
              <strong>WORKER CHECKPOINTS</strong>
              <span>DISPATCH → TERMINAL</span>
            </div>
            <div className="df-panel-body">
              <WorkerCheckpoints checkpoints={view.checkpoints} />
            </div>
          </section>
          <section className="df-panel">
            <div className="df-panel-head">
              <strong>MEASURED METRICS</strong>
              <span>NO INFERRED ZEROS</span>
            </div>
            <div className="df-panel-body">
              <MeasuredMetrics metrics={view.metrics} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
