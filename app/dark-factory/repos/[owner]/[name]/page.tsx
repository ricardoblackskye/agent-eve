"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { type AmmScan } from "../../../../../agent/lib/dark-factory/amm-readiness";
import type { RunSummary } from "../../../../../agent/lib/dark-factory/run-history";
import { AmmScale } from "../../../ui/amm-scale";
import { PanelHead, RunTable, StatePanel } from "../../../ui/components";
import { DEFAULT_POLL_INTERVAL_MS, useRunQuery } from "../../../ui/use-run-query";
import { toTableRows } from "../../../ui/view-model";

/**
 * #414 (epic #403 R2) — the repository detail page.
 *
 * R1's list links every row here, so before this route existed the list's rows all 404'd. The page owns the ORDER and
 * the PAGE, and hands both to the API: sorting or paging in the browser would describe one fetched page and lie about
 * the rest. `createdAt` is the only column the server can order by today, because the keyset cursor is bound to
 * `created_at` + `run_id`; the control therefore offers the direction rather than a column that cannot work.
 *
 * The AMM readiness scale belongs here too, and arrives with R3 (#415).
 */
const PAGE_SIZES = [10, 25, 50] as const;

type Direction = "asc" | "desc";

function runDetailHref(runId: string): string {
  return `/dark-factory/runs/${runId}`;
}

export default function RepoDetailPage() {
  const params = useParams<{ owner: string; name: string }>();
  const router = useRouter();
  const repo = `${params.owner}/${params.name}`;

  const [direction, setDirection] = useState<Direction>("desc");
  const [limit, setLimit] = useState<number>(25);
  const [cursor, setCursor] = useState<string | null>(null);
  // Cursor paging has no back-pointer, so Previous walks a trail of the cursors already used. An empty string stands
  // for the first page, whose request carries no cursor at all.
  const [trail, setTrail] = useState<string[]>([]);

  // The readiness scan arrives through the AmmReadinessProvider seam. Until the scanner exists this is the fixture,
  // which is why it is read here rather than fetched: when the database adapter lands this becomes one request and the
  // scale below does not change, because it renders whatever a scan contains.
  const [scan, setScan] = useState<AmmScan | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    // #465 - the scan arrives across the server boundary, like the runs table: a client component cannot open the
    // store, and a fabricated fallback would look like a measurement that never happened. The route reads the
    // configured store, so this request returns whatever was actually scanned (or nothing).
    void fetch(`/api/dark-factory/amm-scans?repo=${encodeURIComponent(repo)}`)
      .then((response) => (response.ok ? response.json() : undefined))
      .then((data) => {
        if (!cancelled) setScan(data?.scan ?? undefined);
      })
      .catch(() => {
        if (!cancelled) setScan(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [repo]);

  const path = useMemo(() => {
    const search = new URLSearchParams({
      repo,
      sort: "createdAt",
      direction,
      limit: String(limit),
    });
    if (cursor) search.set("cursor", cursor);
    return `/api/dark-factory/runs?${search.toString()}`;
  }, [repo, direction, limit, cursor]);

  const runs = useRunQuery<{ runs: RunSummary[]; nextCursor: string | null }>(path, {
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  });

  const rows = useMemo(
    () => toTableRows(runs.data?.runs ?? [], Date.now()),
    [runs.data],
  );
  const nextCursor = runs.data?.nextCursor ?? null;

  if (runs.error === "Authentication required") {
    return (
      <StatePanel state="auth" message="Sign in required to view the board" />
    );
  }

  return (
    <div className="df-view">
      <div className="df-head">
        <div>
          <h1>{repo}</h1>
          <p>Runs against this repository · ordered and paged by the server</p>
        </div>
        <div className="df-actions">
          <button
            className="df-btn"
            type="button"
            onClick={() => {
              setCursor(null);
              setTrail([]);
              setDirection(direction === "desc" ? "asc" : "desc");
            }}
          >
            {direction === "desc" ? "Oldest first" : "Newest first"}
          </button>
          <select
            className="df-field"
            aria-label="Runs per page"
            value={limit}
            onChange={(event) => {
              setLimit(Number(event.target.value));
              setCursor(null);
              setTrail([]);
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} per page
              </option>
            ))}
          </select>
          <button
            className="df-btn"
            type="button"
            disabled={trail.length === 0}
            onClick={() => {
              const previous = trail.at(-1);
              setTrail(trail.slice(0, -1));
              setCursor(previous === "" ? null : (previous ?? null));
            }}
          >
            Previous
          </button>
          <button
            className="df-btn"
            type="button"
            disabled={!nextCursor}
            onClick={() => {
              setTrail([...trail, cursor ?? ""]);
              setCursor(nextCursor);
            }}
          >
            Next
          </button>
        </div>
      </div>

      <AmmScale repo={repo} scan={scan} />

      <PanelHead title="Runs" />
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
