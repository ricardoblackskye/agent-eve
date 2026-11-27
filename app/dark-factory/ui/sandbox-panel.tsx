"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { SandboxViewResponse } from "../../../agent/lib/dark-factory/sandbox-view";
import { PanelHead } from "./components";
import { DEFAULT_POLL_INTERVAL_MS, useRunQuery } from "./use-run-query";

export interface SandboxViewPanelProps {
  runId: string;
}

/**
 * #790 R1 (#791) - the operator's read-only window into a running local sandbox (task 5).
 *
 * The SERVER decides whether a view exists: this panel asks the endpoint and renders what it is told. That is what
 * keeps a deployed console honest - it has no local sandbox, so the endpoint answers `not-local` and no panel appears,
 * rather than a page pointing at a `127.0.0.1` that is not there.
 *
 * There is nothing to submit here: the panel lists paths, shows one file's contents, and re-reads on demand. The
 * console's run controls live in `ControlPanel` and are deliberately not repeated.
 *
 * `watched` exists for AC5. A run that never had a local sandbox shows no panel at all; a view the operator WAS
 * watching that then ends says so, because "it finished" and "it vanished" should not look the same.
 */

function viewPath(runId: string): string {
  return `/api/dark-factory/runs/${encodeURIComponent(runId)}/sandbox-view`;
}

export function SandboxViewPanel({ runId }: SandboxViewPanelProps): ReactNode {
  const [selected, setSelected] = useState<string | null>(null);
  const [watched, setWatched] = useState(false);

  const listing = useRunQuery<SandboxViewResponse>(runId ? viewPath(runId) : null, {
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  });
  const file = useRunQuery<SandboxViewResponse>(
    runId !== "" && selected !== null ? `${viewPath(runId)}?file=${encodeURIComponent(selected)}` : null,
    { intervalMs: DEFAULT_POLL_INTERVAL_MS },
  );

  const view = listing.data;
  const live = view?.available === true;
  useEffect(() => {
    if (live) setWatched(true);
  }, [live]);

  if (!view || !view.available) {
    if (!watched) return null;
    return (
      <section className="df-panel">
        <PanelHead title="SANDBOX VIEW" badges={["READ-ONLY", "ENDED"]} leading={undefined} />
        <div className="df-panel-body">
          <p>{view?.message ?? "The sandbox view has ended."}</p>
        </div>
      </section>
    );
  }

  const shown = file.data?.available === true ? file.data.file : undefined;

  return (
    <section className="df-panel">
      <PanelHead
        title="SANDBOX VIEW"
        badges={["READ-ONLY", view.sandboxId]}
        action={
          <button className="df-btn" type="button" onClick={() => listing.refresh()}>
            Refresh
          </button>
        }
      />
      <div className="df-panel-body">
        {view.entries.length === 0 ? (
          <p>No files reported under {view.workspace} yet.</p>
        ) : (
          <ul>
            {view.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  className="df-btn"
                  type="button"
                  aria-pressed={selected === entry.path}
                  onClick={() => setSelected(entry.path)}
                >
                  {entry.path}
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected !== null ? (
          <pre aria-label={`Contents of ${selected}`}>
            {shown === undefined
              ? "Reading…"
              : `${shown.content}${shown.truncated ? "\n... (truncated)" : ""}`}
          </pre>
        ) : null}
      </div>
    </section>
  );
}
