# Plan — #312 (split a of #308): wire the circuit breaker into the worker path

**Branch:** `feat/df-wire-breaker-312` (off `origin/main` @ `2693899`)
**Issue:** [#312](https://github.com/ricardoblackskye/agent-eve/issues/312) — split **a** of 2 from #308
**Epic:** #267 (Dark Factory — Pre-UAT Readiness)
**Date:** 2026-10-10

## Goal

Wire the circuit breaker into the worker path so a trip can actually occur. Until this
lands, nothing can trip and #308b has nothing to display.

## Scope decision — option B (split) — RECORDED HERE

#308 was split, on the operator's decision, into:

| | Issue | Scope |
| :--- | :--- | :--- |
| **a** | **#312 (this plan)** | wire the breaker so a trip can occur (the prerequisite) |
| **b** | #313 | persist the trip machine-readably on the run + the dashboard surface |

The wiring is a real **behaviour change on the worker path** (a trip now halts work) and
deserves its own review; the persistence and surfacing are additive and reviewable alone.
Building the surface first would ship a UI that can never display anything. #308 remains
the umbrella.

## Verified finding — the breaker is dead code in production

`createCircuitBreaker` / `createWorkerActivityObserver` / `new CircuitBreaker` are
referenced **only** by: `circuit-breaker.ts` itself, its own test, a **types-only**
re-export in `index.ts`, and the docs/README. `scripts/` has **zero** references and there
is no `worker-env.ts`. So nothing constructs a breaker and no worker activity is recorded.

Two wrinkles that constrain the wiring:

- **The breaker keys on `pbiId`, the ledger on `runId`** — and `PBI_ID_PATTERN`
  (`^[A-Za-z][A-Za-z0-9_-]*$`) rejects the characters in a run id (`/`, `#`, `.`). A run id
  is NOT a usable pbiId.
- **`TripEvent` carries no cap** (`{ pbiId, workerMinutes, reason, timestamp }`). That only
  matters for *displaying* the cap, so it is a #308b decision, not this one.

## Intended fix

1. Construct the breaker from configuration (`createCircuitBreaker(env)`) on the runner's
   path. The knobs are already documented in `.env.example` and already fail closed
   (a malformed value throws rather than silently defaulting) — keep that.
2. Feed one `WorkerActivity { pbiId, durationMs, status }` per **completed coding
   iteration** using the documented adapter `createWorkerActivityObserver(breaker)`.
3. Check `isTripped(pbiId)` **before** starting the next iteration. A tripped breaker
   **halts** the run through the existing terminal path, so the run is never silently left
   running.
4. Log each trip with its machine-readable reason where an operator already looks.
5. Document the cooperative caveat honestly: the halt takes effect at the next iteration
   boundary, not mid-token (the same caveat as pause/stop).

## Decisions I need confirmed (all flagged in the PR too)

1. **pbiId derivation.** I recommend keying on the **ISSUE** (`pbi-<issue>`) rather than a
   sanitised run id: the cap's documented purpose is a cumulative budget per unit of work,
   and the issue is that unit. A per-run key would reset the budget on every retry.
2. **Breaker lifetime — per-run vs per-process.** The class is explicitly NOT thread-safe
   and does not share state across instances. I recommend **per-run** (simplest, matches the
   ledger); per-process would pool concurrent runs into one budget.
3. **On by default?** `createCircuitBreaker(env)` always returns a breaker with the
   documented defaults (60 minutes, 3 failures), so wiring it unconditionally changes runner
   behaviour. I recommend on-by-default (it is a guard and its defaults are documented) and
   will say so plainly in the PR.
4. **What "halt" means.** Reusing the existing terminal-failure path (throw, then the #284
   finalizer applies `df:failed`) is the smaller change; parking the run for a human matches
   the Epic's "a human is pulled in" wording better. I recommend reusing the failure path
   now and recording the parked variant as follow-up.

## Tasks (TDD, one RED to GREEN cycle each)

- **T1** — the iteration boundary records worker activity and consults `isTripped`.
- **T2** — a trip actually halts the run: drive the loop past the configured cap and assert
  the halt (a trip reachable end-to-end, not only unit-tested in isolation).
- **T3** — config stays fail-closed (a malformed knob throws) and the pbiId derivation is
  explicit and tested. Add the ADR if a decision above is recorded.

## Files likely to change

- `scripts/dark-factory-runner.ts` (construct + feed + check)
- a small seam module **only if** the boundary cannot be exercised inline from a test
- `tests/dark-factory/…` (the iteration-boundary test; extend the runner-wiring guard style)
- `docs/adr/0024-*.md` + `docs/adr/README.md` if a decision is recorded

## Validation

- `npx vitest run` (full suite), `npx tsc --noEmit --incremental false`
- `DF_PLATFORM_PROVIDER=generic npm run build`
- cspell, markdownlint, markdown-table-formatter, doc-drift + ADR-integrity guards
- Rebase onto the current `origin/main` before opening the PR (push with the explicit token
  URL — plain `git push` stalls on this host)

## Explicitly out of scope

- Persisting the trip on the run and the dashboard surface (#313).
- Adding the cap to `TripEvent` (only needed to display it — a #313 decision).
- Feeding the still-unwired `DeveloperAgent.usage?: WorkerUsageSink` seam; note it, do not
  fix it here.