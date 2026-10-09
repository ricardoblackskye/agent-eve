"use client";

import { useParams } from "next/navigation";
import Link from "next/link";
import type { RunSummary } from "../../../../agent/lib/dark-factory/run-history";
import type { PersistedRunEvent } from "../../../../agent/lib/dark-factory/run-history-store";
import {
  EventTimeline,
  MeasuredMetrics,
  OutcomeArtifacts,
  PanelHead,
  RunDetailPanel,
  StatePanel,
  WorkerCheckpoints,
} from "../../ui/components";
import { DEFAULT_POLL_INTERVAL_MS, useRunQuery } from "../../ui/use-run-query";
import { useFactoryControl } from "../../ui/use-factory-control";
import { ControlPanel } from "../../ui/control-panel";
import { toDetailView } from "../../ui/view-model";

export default function DarkFactoryRunDetailPage() {
  const params = useParams<{ runId: string }>();
  const runId = typeof params?.runId === "string" ? params.runId : "";
  const control = useFactoryControl({
    runId,
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  });
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
      <section className="df-panel df-control-card">
        <PanelHead
          title="RUN CONTROL"
          leading={
            <Link className="df-btn" href="/dark-factory/runs">
              ← Back to runs
            </Link>
          }
          badges={["COOPERATIVE PAUSE", "TERMINAL STOP"]}
        />
        <div className="df-panel-body">
          <ControlPanel
            loading={control.loading}
            error={control.error}
            unauthenticated={control.unauthenticated}
            pending={control.pending}
            factory={control.data?.factory}
            runId={runId}
            run={control.data?.run}
            runStatus={run.data.summary.status}
            onAction={(action, scope) => {
              void control.act(action, scope);
            }}
          />
        </div>
      </section>
      <RunDetailPanel summary={run.data.summary} view={view} />
      <OutcomeArtifacts prUrl={view.prUrl} />
      <div className="df-detail-grid">
        <section className="df-panel">
          <PanelHead title="EVENT STREAM" badges={["OLDEST → NEWEST"]} />
          <div className="df-panel-body">
            <EventTimeline entries={view.timeline} />
          </div>
        </section>
        <div className="df-stack">
          <section className="df-panel">
            <PanelHead
              title="WORKER CHECKPOINTS"
              badges={["DISPATCH → TERMINAL"]}
            />
            <div className="df-panel-body">
              <WorkerCheckpoints checkpoints={view.checkpoints} />
            </div>
          </section>
          <section className="df-panel">
            <PanelHead
              title="MEASURED METRICS"
              badges={["NO INFERRED ZEROS"]}
            />
            <div className="df-panel-body">
              <MeasuredMetrics metrics={view.metrics} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
