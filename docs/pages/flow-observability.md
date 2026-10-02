# Observability

You cannot operate a recursive agent loop blind. This page covers how the Dark
Factory makes a run **visible**: metrics, durable run history, the read query API,
and the progress board. The control plane that acts on what is observed is
[control plane and gates](flow-control-plane.md).

## Metrics (R1)

[`metrics.ts`](../../agent/lib/dark-factory/metrics.ts) defines the `TaskMetric`
shape (`{taskType, iterations, fixCycles, status}`) and the stable ingestion
interface components grow against. `countFixCycles` counts real fail→fix pairs; an
unmatched failure or fix counts zero. `BufferedMetricsRecorder` retains and retries
any record the backend rejected, so an unsaved metric is never reported as stored.

## Durable run history

[`run-history.ts`](../../agent/lib/dark-factory/run-history.ts) keeps three
identities distinct (delivery ID, run ID, event ID — see
[tenant attribution](flow-tenant-attribution.md)) and projects run summaries that
track attempts, review rounds, iterations, fix cycles, and the PR URL. Storage is
driver-selected: `run-history-sqlite.ts` for local dev, `run-history-postgres.ts`
for deployed runtimes. SQLite is rejected when `NODE_ENV=production` or the stage
is `preview`/`production`
([ADR 0005](../../docs/adr/0005-sqlite-is-local-only.md)); deployed runtimes must
use PostgreSQL.

## The run query API

[`run-query.ts`](../../agent/lib/dark-factory/run-query.ts) is the provider-neutral
application service over the ledger. It depends only on the `RunHistoryStore` read
contract — never on Next.js types or a storage driver — so the HTTP layer stays a
thin adapter. Three route handlers expose it:

- `GET /api/dark-factory/runs` — [`runs/route.ts`](../../app/api/dark-factory/runs/route.ts)
- `GET /api/dark-factory/runs/{id}` — [`runs/[runId]/route.ts`](../../app/api/dark-factory/runs/[runId]/route.ts)
- `GET /api/dark-factory/metrics` — [`metrics/route.ts`](../../app/api/dark-factory/metrics/route.ts)

The full route inventory (with auth posture) is generated from `app/api/**/route.ts` and
`app/auth-gate.ts` — see
[`app/documentation/reference/generators.ts`](../../app/documentation/reference/generators.ts). Viewer auth reads the
`eve_session` cookie and verifies it with `AUTH_SESSION_SECRET`; a missing
production secret fails closed to 401
([`viewer-auth.ts`](../../app/api/dark-factory/viewer-auth.ts)). Every response
sets `Cache-Control: private, no-store`.

## The progress board (UI)

Three Next client pages under `app/dark-factory/` consume only the read API
through a polling hook; the UI has no dependency on any storage driver or Vercel
service. Presentation and logic are separated: `ui/view-model.ts` maps API
payloads to UI state and is unit-tested in the node environment; `ui/components.tsx`
renders that state under jsdom.

Honesty rules are enforced by tests: an absent measurement renders `—` (never
`0`), the "unmeasured" count is derived only as total minus observed, and an
unrecognized event type is displayed literally
([ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md)). The run detail, KPI
tiles, and terminal trend all come from the same read API — there is no second
source of truth.
