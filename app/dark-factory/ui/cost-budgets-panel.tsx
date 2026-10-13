"use client";

import { COST_CATEGORIES } from "../../../agent/lib/dark-factory/cost-budget";
import type { CostBudgetReport } from "../../../agent/lib/dark-factory/cost-budget-query";
import { BarChart } from "./components";
import { useCostBudgets } from "./use-cost-budgets";

/** A value that was never measured renders as an em dash, never as 0. */
const UNMEASURED = "—";

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Read-only operator view of the LLM cost budgets. One row per canonical
 * category; a category with no configured budget shows as an explicit gap
 * rather than a misleading zero. No prompt/completion content is ever shown.
 */
export interface CostBudgetsPanelProps {
  report: CostBudgetReport | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/**
 * Presentational, like its sibling panels: the fetch lives in the container below, so this can be
 * rendered and asserted directly (#277).
 */
export function CostBudgetsPanel({
  report,
  loading,
  error,
  onRefresh,
}: CostBudgetsPanelProps) {
  return (
    <section className="df-cost-card" aria-label="LLM cost budgets">
      <header className="df-cost-head">
        <h2>LLM cost budgets</h2>
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      </header>

      {loading && !report ? <p>Loading budgets…</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      {report ? (
        <>
          <BarChart
            label="Budget burn down"
            bars={report.budgets.flatMap((view, index) =>
              view === null
                ? []
                : [
                    {
                      key:
                        view.category ?? COST_CATEGORIES[index] ?? "category",
                      label:
                        view.category ?? COST_CATEGORIES[index] ?? "category",
                      value: view.spentUsd + view.reservedUsd,
                      display: `${usd(view.spentUsd + view.reservedUsd)} of ${usd(view.capUsd)} committed`,
                    },
                  ],
            )}
          />

          <table className="df-cost-table">
            <thead>
              <tr>
                <th scope="col">Category</th>
                <th scope="col">Cap</th>
                <th scope="col">Spent</th>
                <th scope="col">Reserved</th>
                <th scope="col">Remaining</th>
                <th scope="col">Calls</th>
              </tr>
            </thead>
            <tbody>
              {report.budgets.map((view, index) => (
                <tr key={view?.category ?? COST_CATEGORIES[index]}>
                  <th scope="row">
                    {view?.category ?? COST_CATEGORIES[index]}
                  </th>
                  <td>{view ? usd(view.capUsd) : UNMEASURED}</td>
                  <td>{view ? usd(view.spentUsd) : UNMEASURED}</td>
                  <td>{view ? usd(view.reservedUsd) : UNMEASURED}</td>
                  <td>{view ? usd(view.remainingUsd) : UNMEASURED}</td>
                  <td>{view ? view.callCount : UNMEASURED}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td>{usd(report.totals.capUsd)}</td>
                <td>{usd(report.totals.spentUsd)}</td>
                <td>{usd(report.totals.reservedUsd)}</td>
                <td>{usd(report.totals.remainingUsd)}</td>
                <td>{report.totals.callCount}</td>
              </tr>
            </tfoot>
          </table>
        </>
      ) : null}

      {!loading && !error && !report ? <p>No budgets configured.</p> : null}
    </section>
  );
}

/**
 * Operator-only cost-budget read; polls like the other panels. Separate so the panel above stays
 * presentational and testable (#277).
 */
export function CostBudgetsPanelContainer() {
  const { data, loading, error, refresh } = useCostBudgets();
  return (
    <CostBudgetsPanel
      report={data?.report ?? null}
      loading={loading}
      error={error}
      onRefresh={refresh}
    />
  );
}
