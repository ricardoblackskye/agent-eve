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

## Captured agent output: what survives a run

An Agent's notable output used to die on the console. It is now recorded as a typed, bounded,
redacted summary against the run and posted as a readable comment.

**Three types only** (epic #557): a **decision-question** asks a human (`worker.question`, which
validation requires to carry `blocked`), a **roadblock** is a recoverable problem that the run
reports and carries on from (`worker.roadblock`), and a **milestone** is a stage boundary
(`worker.progress`). The model's full transcript and raw shell output are deliberately **not**
captured.

**Bounded and redacted.** Text is capped at the same 2000-character bound the reporter enforces on
a posted message - the recorder adopts its consumer's limit rather than choosing a ceiling of its
own - and it passes through the diff sanitiser first. That sanitiser rewrites env-file style `DF_*`
assignments; it does **not** rewrite a secret echoed mid-sentence, and a test pins that boundary.
See [ADR 0082](../adr/0082-agent-output-is-a-bounded-summary-not-a-transcript.md).

**Where it lands.** The run ledger stores the bounded summary
(`df_run_events.agent_output_summary`), and the reporter records it against the run and posts one
rolling comment per run, idempotent by `(runId, kind)`, so a retry **edits** rather than
duplicating. The capture is observational: if the store or the reporter fails, the run's own
behaviour is unchanged.

**An unmeasured iteration is a roadblock, not a failure.** When the test command cannot even start
(an unprovisioned checkout, #541) the iteration is *unmeasured* - the environment's failure, not
the developer's. That distinction used to be logged and dropped; it is now recorded as a roadblock
so it survives the console, and the runner returns the iteration as unmeasured exactly as before.

**The Tester's own roadblock is a refused command.** Its runner permits only `npx` with
`{ tsc, cspell, vitest, gitleaks }` and throws for anything else. Because that runner is injected, the
capture wraps it: the refusal is reported through a tap and the error is rethrown unchanged, so the
Tester's verdict is exactly what it was. The tap fires only on the allow-list message rather than on
every `ValidationError`, because that class is also what a caller bug throws - tapping those would
report a programming mistake as an agent roadblock. And a command that runs and *fails* is a normal
result, not a roadblock: only a command that could not run at all is.
