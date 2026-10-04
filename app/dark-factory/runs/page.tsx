"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  RunStatus,
  RunSummary,
} from "../../../agent/lib/dark-factory/run-history";
import { RunTable, StatePanel } from "../ui/components";
import { DEFAULT_POLL_INTERVAL_MS, useRunQuery } from "../ui/use-run-query";
import { filterRows, toQueryParams, toTableRows } from "../ui/view-model";

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "any", label: "Any status" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Active" },
  { value: "blocked", label: "Blocked" },
  { value: "succeeded", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const STAGE_OPTIONS = [
  "any",
  "trigger",
  "dispatch",
  "worker",
  "review",
  "pull-request",
  "terminal",
];

/** The detail route for a run; both the row link and the row click use it. */
function runDetailHref(runId: string): string {
  return `/dark-factory/runs/${runId}`;
}

export default function DarkFactoryRunsPage() {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("any");
  const [stage, setStage] = useState("any");

  const path = useMemo(() => {
    const params = toQueryParams({
      statuses: status !== "any" ? [status as RunStatus] : undefined,
      limit: 50,
    });
    return `/api/dark-factory/runs?${params.toString()}`;
  }, [status]);

  const runs = useRunQuery<{ runs: RunSummary[] }>(path, {
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  });

  const rows = useMemo(
    () =>
      filterRows(toTableRows(runs.data?.runs ?? [], Date.now()), {
        search,
        stage,
      }),
    [runs.data, search, stage],
  );

  if (runs.error === "Authentication required") {
    return (
      <StatePanel state="auth" message="Sign in required to view the board" />
    );
  }

  return (
    <div className="df-view">
      <div className="df-head">
        <div>
          <h1>Execution ledger</h1>
          <p>Dense operator view · select a row to open its run detail</p>
        </div>
        <div className="df-actions">
          <button className="df-btn" type="button" onClick={runs.refresh}>
            ↻ Refresh
          </button>
        </div>
      </div>

      <div className="df-filters">
        <input
          className="df-field"
          placeholder="Filter issue / repository / run id"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="df-field"
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="df-field"
          value={stage}
          onChange={(event) => setStage(event.target.value)}
        >
          {STAGE_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {value === "any" ? "Any stage" : value}
            </option>
          ))}
        </select>
        <small>{`${rows.length} RECORDS`}</small>
      </div>

      <RunTable
        rows={rows}
        loading={runs.loading && !runs.data}
        error={runs.error}
        hrefForRun={runDetailHref}
        onSelect={(runId) => router.push(runDetailHref(runId))}
      />
    </div>
  );
}
