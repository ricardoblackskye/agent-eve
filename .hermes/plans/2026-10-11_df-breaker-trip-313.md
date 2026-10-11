# Plan — #313 (split b of #308): persist and review a breaker trip on the run

**Branch:** `feat/df-breaker-trip-313` (off `origin/main` @ `f6f85b6` — the #312 merge)
**Issue:** [#313](https://github.com/ricardoblackskye/agent-eve/issues/313) — split **b** of 2 from #308
**Epic:** #267 (Dark Factory — Pre-UAT Readiness)
**Date:** 2026-10-11

## Goal

A circuit-breaker trip must be visible **on the run**: persisted machine-readably, shown in
the run detail view, and reviewable by the operator. #312 made a trip *possible*; this makes
it *legible*.

## What already exists (do not rebuild)

- **`cost-refusal-recorder.ts` (#270) is the exact template.** A small recorder that appends
  a terminal, failed run event carrying a machine-readable code, idempotent by a hashed
  eventId (`cost-refusal:<sha256(runId)[:32]>:<code>`), returning `{ ok, error }` rather than
  throwing. `RunEvent.costRefusal` is a **closed vocabulary** (`COST_REFUSALS` + `invalid(…)`).
- **`commentReference` is the template for a STRUCTURED optional `RunEvent` field**: the
  interface, the validator, the `optional…` wrapper, the `toRunEvent` spread, and both store
  adapters.
- **`trace` (#297) / `testResults` (#296)** are the siblings for a `DetailView` field and a
  panel in `app/dark-factory/ui/components.tsx`.
- **The breaker is now wired (#312, merged).** The runner catches `CircuitTrippedError` and
  has `breaker.getTripEvents()` — so the trip payload is already in hand at a terminal path.
  The trip reasons are a closed vocabulary: `worker-minutes-exceeded |
  failed-selfcorrect-exceeded`.

## Open decision 1 — the cap is not in the trip payload (my recommendation: ADD IT)

`TripEvent` is `{ pbiId, workerMinutes, reason, timestamp }` — it records what *happened*
(`workerMinutes`) but not what was *hit* (the cap), which the UI must show.

**Recommendation: add an optional `limit` to `TripEvent`,** set by the breaker's own `trip()`
from its own config for the reason hit:

| reason | limit |
| :--- | :--- |
| `worker-minutes-exceeded` | `maxWorkerMinutesPerPbi` |
| `failed-selfcorrect-exceeded` | `maxFailedSelfCorrect` |

The trip then means what the UI needs, and nothing re-derives the breaker's defaults elsewhere.
The alternative — persisting the cap from `process.env` at the record site — duplicates the
documented defaults (`60`, `3`) in a second place, which is precisely the "one definition of a
setting, not two" rule this repo follows. The field is optional, so existing `TripEvent` tests
keep passing.

## Open decision 2 — the operator action has a REAL scope problem (needs your call)

The issue's AC says the operator can act: *"stop the run, clear the trip, or deliberately
raise the cap"*. Two of those three are **not reachable from a dashboard**, and I will not
pretend otherwise:

| Action | Reachable? | Why |
| :--- | :--- | :--- |
| **Stop the run** | **Yes** | The existing control plane already does this (`abort`, #307). |
| **Clear the trip** | **No, not literally** | The breaker is **in-memory and per-run inside the runner process**. A dashboard request cannot reach another process's breaker, so "clear" cannot mean "un-trip a live breaker". |
| **Raise the cap** | **No** | `DF_MAX_WORKER_MINUTES_PER_PBI` is **deploy-time** config read at run start, with a fail-closed env contract. Raising it mid-run is a configuration change, like the LLM policy. |

**My recommendation:**
1. **Stop** — reuse `abort` (already shipped).
2. **Clear** — means the operator **ACKNOWLEDGES** the trip **on the run**: a recorded control
   event with actor + reason. The ledger is the durable record; acknowledging it says "seen and
   dispositioned", which is the real need. Building a genuinely shared breaker store would
   contradict the breaker's documented "state is IN-MEMORY by design" and is a much larger change.
3. **Raise the cap** — **out of code scope**: I will give you exact steps to change the env var
   (and note that the change applies to the NEXT run, not a run already tripped).

## Tasks (TDD, RED → GREEN per task)

- **T1** — `RunEvent.breakerTrip?: BreakerTrip` with a closed-vocabulary validator, mirroring
  `commentReference` **field-for-field** across `run-history.ts`, `run-history-store.ts` (sqlite)
  and `run-history-postgres.ts` (column, row type, `rowToEvent`, `INSERT` list + placeholder,
  `CREATE TABLE` text, idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).
- **T2** — `TripEvent.limit?: number`, set from the breaker's own config; `toTripEvent` +
  its validator updated; the existing breaker suite stays green.
- **T3** — `breaker-trip-recorder.ts`: `recordBreakerTrip(history, { runId, trip, occurredAt })`
  in the `cost-refusal-recorder` shape — idempotent hashed eventId, terminal + failed, returns
  `{ ok, error }`.
- **T4** — runner wiring: on `CircuitTrippedError`, record the trip **and** keep the existing
  terminal-failure path. **Honest fail-closed**: if the record cannot be written, the trip is
  logged loudly and the run still fails — a trip is never silently dropped (mirroring #270).
- **T5** — `DetailView.breakerTrip` in `view-model.ts` + a `BreakerTripPanel` **sibling** panel
  (the established pattern; NOT inside `OutcomeArtifacts`) rendering the reason, the cap hit and
  the measured minutes, plus a view-model + UI test.
- **T6** — the operator acknowledge action, per your call on Open decision 2.

## Files likely to change

`agent/lib/dark-factory/run-history.ts`, `run-history-store.ts`, `run-history-postgres.ts`,
`circuit-breaker.ts`, `breaker-trip-recorder.ts` (**new** — requires a catalog row + count bump
in `docs/pages/dark-factory-modules.md`, recomputed as `ls -1 agent/lib/dark-factory/*.ts | wc -l`),
`scripts/dark-factory-runner.ts`, `app/dark-factory/ui/view-model.ts`, `components.tsx`,
`app/dark-factory/runs/[runId]/page.tsx`, tests, ADR + `docs/adr/README.md`.

An **ADR** is warranted here (a new ledger field + the operator-action scope decision). Hold the
number until #311's ADR 0023 status is known, or take the next free number off `main`.

## Validation

- `npx vitest run` (full suite), `npx tsc --noEmit --incremental false`
- `DF_PLATFORM_PROVIDER=generic npm run build`
- **cspell over EVERY changed file** (`git diff --name-only origin/main...HEAD`), prettier on code
  only (**never on `.md`**), doc-drift + ADR-integrity guards
- Rebase onto the then-current `origin/main` **and push the rebase**, then confirm
  `git rev-list --count HEAD..origin/main` == 0 and remote HEAD == local
- Opt-in Postgres integration run for the new column (`DF_RUN_HISTORY_TEST_DATABASE_URL`)

## Explicitly out of scope

- A cross-process/shared breaker store (contradicts the in-memory design decision).
- Making the cap editable at runtime (deploy-time config; exact operator steps supplied instead).
- #306/#307's surfaces; the parked-for-a-human variant noted in #312.