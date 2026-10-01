"use client";

import type { LlmPolicyReport } from "../../../agent/lib/dark-factory/llm-policy-query";
import { useLlmPolicy } from "./use-llm-policy";

/** A value that was not applied renders as an em dash, never as a bare "no". */
const NOT_APPLIED = "—";

export interface LlmPolicyPanelProps {
  report: LlmPolicyReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/**
 * Read-only operator view of the effective LLM call policy (#208).
 *
 * The policy is env-driven, so this shows what the deployment will actually do.
 * A surface whose model cannot reason is reported as NOT applied with the
 * reason, rather than implying the thinking level took effect everywhere.
 */
export function LlmPolicyPanel({
  report,
  loading,
  error,
  onRefresh,
}: LlmPolicyPanelProps) {
  const degraded = (report?.surfaces ?? []).filter(
    (surface) => surface.reason !== undefined,
  );

  return (
    <section className="df-policy-card" aria-label="LLM call policy">
      <header className="df-policy-head">
        <h2>LLM call policy</h2>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </header>

      {loading && !report ? <p>Loading policy…</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      {report ? (
        <>
          {report.configured ? (
            <dl className="df-policy-summary">
              <dt>Thinking level</dt>
              <dd>{report.thinkingLevel}</dd>
              <dt>Max steps</dt>
              <dd>{report.maxSteps}</dd>
              <dt>Model</dt>
              <dd>{report.model ?? "per surface"}</dd>
            </dl>
          ) : (
            <p>No policy configured — each surface uses its own defaults.</p>
          )}

          <table className="df-policy-table">
            <caption>Per-surface application</caption>
            <thead>
              <tr>
                <th scope="col">Surface</th>
                <th scope="col">Model</th>
                <th scope="col">Thinking applied</th>
              </tr>
            </thead>
            <tbody>
              {report.surfaces.map((surface) => (
                <tr key={surface.surface}>
                  <th scope="row">{surface.surface}</th>
                  <td>{surface.model}</td>
                  <td>{surface.applied ? "yes" : NOT_APPLIED}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {degraded.map((surface) => (
            <p key={surface.surface} className="df-policy-note">
              {surface.reason}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}

/** Container that reads the policy API and feeds the presentational panel. */
export function LlmPolicyPanelContainer() {
  const { data, loading, error, refresh } = useLlmPolicy();
  return (
    <LlmPolicyPanel
      report={data?.report ?? null}
      loading={loading}
      error={error}
      onRefresh={refresh}
    />
  );
}
