"use client";

import type { RunSummary } from "../../../agent/lib/dark-factory/run-history";
import type { TenantBudgetReport } from "../../../agent/lib/dark-factory/tenant-budget-query";
import type { UsageReport } from "../../../agent/lib/dark-factory/usage-query";
import { PanelHead } from "./components";
import { formatCostUsd } from "./format";
import { DEFAULT_POLL_INTERVAL_MS, useRunQuery } from "./use-run-query";

/**
 * Dark Factory — the customer view (#215, epic #212 R3).
 *
 * What a CUSTOMER sees: their own runs, their own usage and their own budget
 * status, read-only. Every figure here is already scoped server-side — the
 * routes derive the tenant from the caller's membership and ignore a
 * caller-supplied tenant — so this view is presentational and holds no scope
 * logic of its own. It deliberately offers no control, no policy and no
 * cross-customer comparison.
 *
 * An absent measurement renders as `—`, never `0`.
 */

/** A value that was never measured renders as an em dash, never as 0. */
const UNMEASURED = "—";

function measured(value: number | undefined): string {
  return value === undefined ? UNMEASURED : String(value);
}

function money(value: number | undefined): string {
  return value === undefined ? UNMEASURED : formatCostUsd(value);
}

export interface CustomerViewProps {
  runs: RunSummary[] | null;
  usage: UsageReport | null;
  budgets: TenantBudgetReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

export function CustomerView({
  runs,
  usage,
  budgets,
  loading,
  error,
  onRefresh,
}: CustomerViewProps) {
  const group = budgets?.available ? (budgets.tenants[0] ?? null) : null;
  // "No budget configured" is distinct from "no spend": a tenant with no rows
  // gets a sentence, never a table of zeroes.
  const configuredGroup = group?.configured ? group : null;

  return (
    <div className="df-view">
      <div className="df-head">
        <div>
          <h1>Your account</h1>
          <p>Your runs, your LLM usage and your budget · read only</p>
        </div>
        <div className="df-actions">
          <button className="df-btn" type="button" onClick={onRefresh}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {loading && !runs && !usage ? <p>Loading your account…</p> : null}
      {error ? (
        <p className="df-banner" role="alert">
          {error}
        </p>
      ) : null}

      <section className="df-panel">
        <PanelHead title="YOUR RUNS" badges={["READ ONLY"]} />
        <div className="df-panel-body">
          {runs && runs.length === 0 ? <p>No runs yet.</p> : null}
          {runs && runs.length > 0 ? (
            <table className="df-usage-table">
              <caption>Runs attributed to your account</caption>
              <thead>
                <tr>
                  <th scope="col">Run</th>
                  <th scope="col">Repository</th>
                  <th scope="col">Issue</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.runId}>
                    <th scope="row">{run.runId}</th>
                    <td>{run.repo}</td>
                    <td>{run.issue}</td>
                    <td>{run.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>

      <section className="df-panel">
        <PanelHead title="YOUR USAGE" badges={["READ ONLY", "COUNTS ONLY"]} />
        <div className="df-panel-body">
          {usage ? (
            <table className="df-usage-table">
              <caption>LLM usage for your account</caption>
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
                  <th scope="row">Total</th>
                  <td>{usage.totals.calls}</td>
                  <td>{measured(usage.totals.tokensIn)}</td>
                  <td>{measured(usage.totals.tokensOut)}</td>
                  <td>{money(usage.totals.costUsd)}</td>
                  <td>{usage.unmeasured}</td>
                </tr>
              </tbody>
            </table>
          ) : null}
        </div>
      </section>

      <section className="df-panel">
        <PanelHead title="YOUR BUDGET" badges={["READ ONLY"]} />
        <div className="df-panel-body">
          {budgets && !budgets.available ? (
            <p role="alert">
              {budgets.error ?? "Budget status is unavailable"}
            </p>
          ) : null}
          {budgets && budgets.available && !configuredGroup ? (
            <p>No budget has been set for your account.</p>
          ) : null}
          {configuredGroup ? (
            <table className="df-usage-table">
              <caption>Budget for {configuredGroup.name}</caption>
              <thead>
                <tr>
                  <th scope="col">Category</th>
                  <th scope="col">Cap</th>
                  <th scope="col">Settled</th>
                  <th scope="col">Remaining</th>
                  <th scope="col">Calls</th>
                </tr>
              </thead>
              <tbody>
                {configuredGroup.budgets.map((row) => (
                  <tr key={row.category}>
                    <th scope="row">{row.category}</th>
                    <td>{money(row.capUsd)}</td>
                    <td>{money(row.settledUsd)}</td>
                    <td>{money(row.remainingUsd)}</td>
                    <td>{measured(row.callCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** Container: reads the three customer-scoped endpoints and feeds the view. */
export function CustomerViewContainer() {
  const intervalMs = DEFAULT_POLL_INTERVAL_MS;
  const runs = useRunQuery<{ runs: RunSummary[] }>(
    "/api/dark-factory/runs?limit=10",
    { intervalMs },
  );
  const usage = useRunQuery<{ report: UsageReport }>(
    "/api/dark-factory/usage",
    {
      intervalMs,
    },
  );
  const budgets = useRunQuery<{ report: TenantBudgetReport }>(
    "/api/dark-factory/tenant-budgets",
    { intervalMs },
  );

  const errors = [runs.error, usage.error, budgets.error].filter(
    (value): value is string => value !== null,
  );

  return (
    <CustomerView
      runs={runs.data?.runs ?? null}
      usage={usage.data?.report ?? null}
      budgets={budgets.data?.report ?? null}
      loading={runs.loading || usage.loading || budgets.loading}
      error={errors[0] ?? null}
      onRefresh={() => {
        runs.refresh();
        usage.refresh();
        budgets.refresh();
      }}
    />
  );
}
