# Plan: Run details validation (#262, CI)

## Goal
The Run Details page (`/dark-factory/runs/<id>`) must show real detail values
from the seed, and those values must be **validated against the actual
store + page code** (TDD). Resume / Stop controls must work.

## Issue AC (from #262)
- Started (date/time)
- Elapsed (time)
- Attempts (number)
- Review/Round (number)
- Estimate Cost (£)
- Measured metrics: Iterations, Fix cycles
> "These values must be part of the seed data. They also must be validated
> against the actual code (within the sandbox coding processes). The 'resume
> run' and 'stop run' buttons must work."

## Findings from recon (current state)
- `RunSummary` (`run-history.ts:53`) already declares every field: startedAt,
  completedAt, attemptCount, reviewCount, iterationCount, fixCycleCount,
  latencyMs, costUsd, prUrl.
- `toDetailView` (`view-model.ts:310`) already builds `summaryTiles`
  (Started, Elapsed, Attempts, Review round, Measured cost) and `metrics`
  (Latency, Iterations, Fix cycles, Total findings...) and `DetailView`.
- `queryRunDetail` (`run-query.ts:320`) reads `store.getRun(runId)` from
  `df_run_summaries` (readSummary `run-history-store.ts:188`).
- **GAP:** `seed-test-data.ts#ensureRun` (line 196) accepts a run and, for a
  non-`queued` status, appends a SINGLE terminal/dispatch/question event with
  **no** metric fields -> `df_run_summaries` columns stay null/0 -> the page blanks.
- Resume/Stop: `ControlPanel` (`app/dark-factory/ui/control-panel.tsx`) calls the
  control API; `run-detail-page.test.tsx` stubs `/api/dark-factory/control` but
  does NOT assert the buttons render or issue resume/stop actions.

## Design decision
Seed the metrics through the same event path the runtime uses
(`run.accepted` -> `dispatch.started` -> ... -> `run.terminal`) so
`applyRunEvent` aggregates them into `df_run_summaries` — i.e. the seed stays a
faithful, provider-agnostic record of a real run (no raw SQL inserts). The
`unmeasured` usage invariant is preserved (cost/latency stay absent there);
only measured runs get metrics.

## TDD phases (red -> green per phase)
### T1 — seed populates run details (RED -> GREEN)
RED: `tests/dark-factory/seed-test-data.test.ts` asserts the happy-path seeded
run summary has `startedAt`, `attemptCount>0`, `reviewCount>0`,
`iterationCount>0`, `fixCycleCount>0`, `costUsd` defined, `latencyMs` defined,
`prUrl` defined (Elapsed derives from startedAt+completedAt).
GREEN: enrich `ensureRun` to emit metric-bearing events so the summary is
populated. Idempotent on re-run.
### T2 — page renders the details (validation guard)
Assert `run-detail-page.test.tsx` renders Started/Elapsed/Attempts/Review
round/Measured cost/Iterations/Fix cycles using the SUMMARY values. (Likely green
on arrival -> locks the wiring vs code, satisfying AC #2.)
### T3 — Resume/Stop work (RED -> GREEN)
Assert the detail page renders Resume + Stop buttons and that clicking them
POSTs the action to `/api/dark-factory/control` (assert fetch called with the
action scope). Wire if missing.

## Out of scope (per your rules)
- No branch-ruleset / deploy-gating toggles (you admin those).
- No PR without your go-ahead (SDLC gate) — I'll push + request after local gates.
