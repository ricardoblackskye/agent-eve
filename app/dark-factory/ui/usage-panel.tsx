"use client";

import type { UsageReport } from "../../../agent/lib/dark-factory/usage-query";
import { useUsage } from "./use-usage";

/** A value that was never measured renders as an em dash, never as 0. */
const UNMEASURED = "—";

function usd(value: number | undefined): string {
  return value === undefined ? UNMEASURED : `$${value.toFixed(2)}`;
}

function count(value: number | undefined): string {
  return value === undefined ? UNMEASURED : String(value);
}

export interface UsagePanelProps {
  report: UsageReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/**
 * Read-only operator view of the LLM usage ledger.
 *
 * Counts only — no prompt or completion content is ever shown. Every measured
 * value is optional, so an unmeasured sum renders as `—` rather than `$0.00`:
 * a zero would read as "this cost nothing" when the truth is "nobody measured".
 */
export function UsagePanel({
  report,
  loading,
  error,
  onRefresh,
}: UsagePanelProps) {
  const empty = report !== null && report.totals.calls === 0 && report.unmeasured === 0;

  return (
    <section className="df-usage-card" aria-label="LLM usage">
      <header className="df-usage-head">
        <h2>LLM usage</h2>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </header>

      {loading && !report ? <p>Loading usage…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {empty ? <p>No usage recorded.</p> : null}

      {report && !empty ? (
        <>
          <table className="df-usage-table">
            <caption>Totals</caption>
            <thead>
              <tr>
                <th scope="col">Calls</th>
                <th scope="col">Tokens in</th>
                <th scope="col">Tokens out</th>
                <th scope="col">Cost</th>
                <th scope="col">Unmeasured</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{report.totals.calls}</td>
                <td>{count(report.totals.tokensIn)}</td>
                <td>{count(report.totals.tokensOut)}</td>
                <td>{usd(report.totals.costUsd)}</td>
                <td>{report.unmeasured}</td>
              </tr>
            </tbody>
          </table>

          <table className="df-usage-table">
            <caption>By model</caption>
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Calls</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {report.byModel.map((row) => (
                <tr key={row.model}>
                  <th scope="row">{row.model}</th>
                  <td>{row.calls}</td>
                  <td>{usd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="df-usage-table">
            <caption>By day</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Calls</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {report.byDay.map((row) => (
                <tr key={row.date}>
                  <th scope="row">{row.date}</th>
                  <td>{row.calls}</td>
                  <td>{usd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table className="df-usage-table">
            <caption>By run</caption>
            <thead>
              <tr>
                <th scope="col">Run</th>
                <th scope="col">Calls</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {report.byRun.map((row) => (
                <tr key={row.runId}>
                  <th scope="row">{row.runId}</th>
                  <td>{row.calls}</td>
                  <td>{usd(row.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

/** Container that reads the usage API and feeds the presentational panel. */
export function UsagePanelContainer() {
  const { data, loading, error, refresh } = useUsage();
  return (
    <UsagePanel
      report={data?.report ?? null}
      loading={loading}
      error={error}
      onRefresh={refresh}
    />
  );
}