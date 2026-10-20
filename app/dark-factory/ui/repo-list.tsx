import type { ReactNode } from "react";

import { PanelHead } from "./components";

export interface RepoListProps {
  readiness: { atOrAboveFloor: number; active: number; pct: number };
  rows: readonly { repo: string; level: number; label: string }[];
}

/**
 * #413 (epic #403 R1) — the repositories the factory is working on.
 *
 * Presentational on purpose: it takes rows and a readiness summary and renders them, so the page owns data access
 * and these tests need no server. The headline is the leadership metric from the whitepaper — the share of active
 * repos at Level 3 or above, because "80% of our active repos are agent-ready" is more actionable than an average.
 */
export function RepoList({ readiness, rows }: RepoListProps): ReactNode {
  return (
    <section className="df-panel" aria-label="Repositories">
      <PanelHead title="Repositories" />
      <p className="df-panel-subtitle">
        {readiness.pct}% of {readiness.active} active repos are agent-ready (Level 3 or above)
      </p>
      {rows.length === 0 ? (
        <p className="df-panel-empty">
          No configured repository has a readiness scan yet. Repositories appear here once the AMM scanner has scored
          them.
        </p>
      ) : (
        <table className="df-table">
          <thead>
            <tr>
              <th scope="col">Repository</th>
              <th scope="col">AMM readiness</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.repo}>
                <td>
                  <a href={`/dark-factory/repos/${row.repo}`}>{row.repo}</a>
                </td>
                <td>{row.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
