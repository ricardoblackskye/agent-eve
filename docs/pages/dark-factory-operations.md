# Dark Factory operations

## Durable Dark Factory run history (#198)

`agent/lib/dark-factory/run-history.ts` defines provider-neutral run summaries,
validated lifecycle events, and projection rules. `run-history-store.ts` provides
SQLite persistence for local development; `run-history-postgres.ts` uses the
standard PostgreSQL protocol for durable deployments. PostgreSQL works with
Supabase as a managed host without a Supabase SDK or Vercel dependency.

The ledger keeps three identities distinct: GitHub delivery IDs deduplicate
webhook redelivery, opaque run IDs identify executions, and stable event IDs
identify lifecycle transitions. A replayed trigger delivery reuses its bound
run; a distinct trigger delivery gets a fresh run ID. Abort/resume receipts stay
pinned to their original run (or record that no eligible run existed), so a
late replay cannot mutate a later run. Lifecycle event appends and summary
projections are atomic. Replaying an identical event is a no-op; a reused event
ID with different contents is rejected. The store exposes bounded summary/event
queries; the read API (#199) is built on them (see below). #198 does not add the progress board
tracked by #200.

Run summaries track attempts, review rounds, iterations, fix cycles, and the PR
URL. Latency and cost are optional measured values: absent measurements remain
absent, while an explicitly measured zero is preserved. Set
`DF_RUN_HISTORY_DRIVER=postgres` and `DF_RUN_HISTORY_DATABASE_URL` for a durable
PostgreSQL endpoint, or `DF_RUN_HISTORY_DRIVER=sqlite` and
`DF_RUN_HISTORY_DB_PATH` for local development. SQLite is rejected when
`NODE_ENV=production` or the selected deployment stage is `preview` or
`production`; deployed runtimes must use PostgreSQL. An unset driver refuses
writes rather than claiming in-memory data is durable.

## Dark Factory run query API (#199)

`run-query.ts` is the provider-neutral application service over the #198 ledger.
It depends only on the `RunHistoryStore` read contract — never on Next.js types
or a storage driver — so identical query semantics hold for SQLite and
PostgreSQL and the HTTP layer stays a thin adapter. It adds the two read
capabilities the ledger lacked: a validated inclusive-`from` / exclusive-`to`
date filter, and aggregate metrics (per-status counts, a terminal-outcome trend
grouped by `completedAt`, and latency/cost sums with observation counts; absent
measurements stay absent).

Three thin Route Handlers under `app/api/dark-factory/` expose it:

| Route                             | Handler file            |
|-----------------------------------|-------------------------|
| `GET /api/dark-factory/runs`      | `runs/route.ts`         |
| `GET /api/dark-factory/runs/{id}` | `runs/[runId]/route.ts` |
| `GET /api/dark-factory/metrics`   | `metrics/route.ts`      |

Design boundaries:

- **Viewer auth at the edge only.** `viewer-auth.ts` reads the `eve_session`
  cookie and verifies it with the existing `AUTH_SESSION_SECRET` (no new
  viewer-auth variable); a missing production secret fails closed to 401.
  `proxy.ts` remains the fail-closed first line for unknown `/api/*` paths.
- **Opaque cursors.** List and event cursors are base64url-encoded and validated
  before use; the store's internal cursor shape never reaches the caller, and a
  tampered cursor is a 400, not a silently wrong page.
- **Distinct failure modes.** Not-found (`value: null` → 404) stays separate from
  a blocked/unconfigured store (→ 503). Internal error text, SQL, connection
  strings, and provider identifiers are never returned.
- **No-store.** Every response sets `Cache-Control: private, no-store`.
- **Portability.** No Vercel SDK and no storage-specific import in the query
  service; swapping `DF_RUN_HISTORY_DRIVER` changes the adapter, not the API.

## Dark Factory progress board (UI, #200)

The board is three Next 16 client pages under `app/dark-factory/`. They consume
only the #199 read API (`/api/dark-factory/*`) through a small polling hook
(`ui/use-run-query.ts`: 60 s interval, manual refresh, and a 401 surfaced as an
explicit auth state), so the UI has no dependency on any storage driver or
Vercel service.

Presentation and logic are separated. `ui/view-model.ts` is a pure module that
maps API payloads to UI state (KPI tiles, outcome-mix percentages that sum to
100 via a largest-remainder allocation, terminal trend grouped by day, resource
snapshot, table rows, and the run-detail view) and is unit-tested in the `node`
environment. `ui/components.tsx` renders that state and is tested under `jsdom`
with Testing Library across the empty / loading / error / active / blocked /
terminal states.

Honesty rules are enforced by tests: an absent measurement renders `—` (never
`0`), the "unmeasured" count is derived only as total minus observed, and an
unrecognized event type is displayed literally rather than guessed. Styling is
plain CSS in `app/globals.css` (the `.df-*` operator-split rules); the trend
chart is inline CSS with no third-party chart dependency.
