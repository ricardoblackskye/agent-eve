"use client";

import type { ReactNode } from "react";
import type {
  TenantBudgetReport,
  TenantBudgetView,
} from "../../../agent/lib/dark-factory/tenant-budget-query";
import { useTenantBudgets } from "./use-tenant-budgets";

export interface TenantBudgetPanelProps {
  report: TenantBudgetReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/** A value that was never measured renders as an em dash, never as 0. */
const UNMEASURED = "—";

function usd(value: number | undefined): string {
  return value === undefined ? UNMEASURED : `$${value.toFixed(2)}`;
}

function count(value: number | undefined): string {
  return value === undefined ? UNMEASURED : String(value);
}

/**
 * Read-only operator view of the per-customer LLM budget state (#231).
 *
 * Two states are kept DISTINCT from "no spend", so an operator is not sent
 * hunting for the wrong problem: an unreadable store, and a customer with no
 * budget configured at all. An unmeasured value renders as `—`, never `0`.
 * Counts only — no prompt or completion content.
 */
export function TenantBudgetPanel({
  report,
  loading,
  error,
  onRefresh,
}: TenantBudgetPanelProps): ReactNode {
  const rows: TenantBudgetView[] =
    report?.tenants.flatMap((tenant) => tenant.budgets) ?? [];
  const unconfigured = (report?.tenants ?? []).filter(
    (tenant) => !tenant.configured,
  );

  return (
    <section className="df-budget-card" aria-label="Customer budgets">
      <header className="df-budget-head">
        <h2>Customer budgets</h2>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </header>

      {loading && !report ? <p>Loading budgets…</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      {report && !report.available ? (
        <p role="alert">
          {report.error ?? "Cost budget store is unavailable"}
        </p>
      ) : null}

      {report?.available ? (
        <>
          {rows.length > 0 ? (
            <table className="df-budget-table">
              <caption>{`Period ${report.period}`}</caption>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Category</th>
                  <th scope="col">Cap</th>
                  <th scope="col">Settled</th>
                  <th scope="col">Reserved</th>
                  <th scope="col">Remaining</th>
                  <th scope="col">Calls</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    className="df-budget-row"
                    key={`${row.tenantId}-${row.category}`}
                  >
                    <th scope="row">{row.name}</th>
                    <td>{row.category}</td>
                    <td>{usd(row.capUsd)}</td>
                    <td>{usd(row.settledUsd)}</td>
                    <td>{usd(row.reservedUsd)}</td>
                    <td>{usd(row.remainingUsd)}</td>
                    <td>{count(row.callCount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No customer budgets configured.</p>
          )}

          {unconfigured.length > 0 ? (
            <p className="df-budget-note">
              {`No budget configured for: ${unconfigured
                .map((tenant) => tenant.name)
                .join(", ")}`}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Container that reads the tenant budget API and feeds the presentational panel. */
export function TenantBudgetPanelContainer(): ReactNode {
  const { report, loading, error, refresh } = useTenantBudgets();

  return (
    <TenantBudgetPanel
      report={report}
      loading={loading}
      error={error}
      onRefresh={refresh}
    />
  );
}