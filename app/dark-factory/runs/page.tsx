"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  RunStatus,
  RunSummary,
} from "../../../agent/lib/dark-factory/run-history";
import { RunTable, StatePanel } from "../ui/components";
import { DEFAULT_POLL_INTERVAL_MS, useRunListQuery } from "../ui/use-run-query";
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, cursorBounds, toTableRows } from "../ui/view-model";
import type { RunFilters } from "../ui/view-model";

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
  // The size and the cursor stack live in the URL, so a view is shareable and a link opens the page
  // it names. Component state is the one place this must NOT live.
  const searchParams = useSearchParams();
  const sizeParam = Number.parseInt(searchParams.get("size") ?? "", 10);
  const size = PAGE_SIZE_OPTIONS.includes(sizeParam) ? sizeParam : DEFAULT_PAGE_SIZE;
  const cursors = searchParams.getAll("cursor");

  const showPage = useCallback(
    (nextSize: number, nextCursors: string[]) => {
      const params = new URLSearchParams();
      if (nextSize !== DEFAULT_PAGE_SIZE) params.set("size", String(nextSize));
      for (const token of nextCursors) params.append("cursor", token);
      const query = params.toString();
      router.push(query ? `/dark-factory/runs?${query}` : "/dark-factory/runs");
    },
    [router],
  );
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("any");
  const [stage, setStage] = useState("any");

  // The store filters, not this page: with paging, a filter applied here would hide matches on
  // pages the client never fetched.
  const filters = useMemo<RunFilters>(
    () => ({
      statuses: status !== "any" ? [status as RunStatus] : undefined,
      search: search.trim() || undefined,
      stage: stage !== "any" ? stage : undefined,
    }),
    [status, search, stage],
  );

  const runs = useRunListQuery<{ runs: RunSummary[]; nextCursor?: string | null }>(
    filters,
    { size, cursor: cursors.length ? cursors[cursors.length - 1] : undefined },
    { intervalMs: DEFAULT_POLL_INTERVAL_MS },
  );

  // The total is the server s when it reports one; until then the rows it returned are the count.
  // Back and forward come from the reader s own stack and the cursor the server returned.
  const bounds = cursorBounds(cursors.length + 1, runs.data?.nextCursor ?? null);

  const rows = useMemo(() => toTableRows(runs.data?.runs ?? [], Date.now()), [runs.data]);

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
          <label className="df-field" htmlFor="df-page-size">
            Rows per page
          </label>
          <select
            id="df-page-size"
            className="df-field"
            value={String(size)}
            onChange={(event) => {
              showPage(Number(event.target.value), []);
            }}
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={String(option)}>
                {option}
              </option>
            ))}
          </select>
          <button
            className="df-btn"
            type="button"
            aria-label="Previous page"
            disabled={!bounds.canGoBack}
            onClick={() => showPage(size, cursors.slice(0, -1))}
          >
            ‹
          </button>
          <button
            className="df-btn"
            type="button"
            aria-label="Next page"
            disabled={!bounds.canGoForward}
            onClick={() => showPage(size, [...cursors, runs.data?.nextCursor ?? ""])}
          >
            ›
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
