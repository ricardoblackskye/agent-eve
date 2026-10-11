# 0024 — A circuit-breaker trip is recorded on the run, and its cap is stamped by the breaker

- **Status:** Accepted
- **Date:** 2026-10-11
- **Issue:** [#313](https://github.com/ricardoblackskye/agent-eve/issues/313) (split b of #308)

## Context

`circuit-breaker.ts` (#144) keeps trips as an **in-memory** `TripEvent` list, emitted for
external logging. #312 wired the breaker into the coding loop, so a trip now halts a run —
but a trip that only reaches a log is invisible to the operator reading the ticket, and the
trip payload did not even carry the bound that was exceeded.

## Decision

1. **A trip is persisted on the run** as `RunEvent.breakerTrip`: a **closed vocabulary** of
   reasons (`worker-minutes-exceeded | failed-selfcorrect-exceeded`) plus the numeric bound that
   was hit. Never free text. Written by `breaker-trip-recorder.ts`, mirroring
   `cost-refusal-recorder.ts` (#270): idempotent per (run, reason), a terminal failed event, and
   `{ ok, error }` rather than a throw.
2. **`TripEvent` gains an optional `limit`,** stamped by the breaker's **own** config for the
   reason hit (`maxWorkerMinutesPerPbi`, or `maxFailedSelfCorrect`). The alternative —
   persisting the cap from `process.env` at the record site — duplicates the documented
   defaults (60, 3) in a second place, which is the "one definition of a setting" rule this
   repo holds to.
3. **The operator's action is the existing `abort`** (#307). No "clear the trip" control is
   built: the breaker is in-memory and per-run, so a dashboard cannot un-trip a live breaker,
   and shipping a button that cannot work is the trap #307 already found. No runtime cap edit
   either — the cap is deploy-time config, like the LLM policy.

## Consequences

- A tripped run is explainable **on the ticket**: the reason, the cap that was hit, and the
  minutes measured.
- **Fail-closed in the honest direction:** if the ledger write fails, the trip is logged loudly
  and the run still fails — a trip is never silently dropped. A trip carrying no `limit` is
  reported rather than given an invented cap (`0` would be a lie).
- The breaker stays a pure in-memory guard; it is never taught about the ledger.
- Raising `DF_MAX_WORKER_MINUTES_PER_PBI` applies to the **next** run, not to one already tripped.
