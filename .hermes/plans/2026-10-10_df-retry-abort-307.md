# Plan — #307: retry / abort a failed run from the detail view

**Branch:** `feat/df-retry-abort-307` (off `origin/main` @ `2693899`)
**Issue:** [#307](https://github.com/ricardoblackskye/agent-eve/issues/307) — split B of #273
**Epic:** #267 (Dark Factory — Pre-UAT Readiness)
**Date:** 2026-10-10

## Goal

A human can retry a failed run and abort a run from the run detail view, with `aborted`
unambiguously distinct from the existing `stop`.

## Verified today — do NOT rebuild

- **Control plane** (`control.ts`): `ControlAction = "pause" | "resume" | "stop"`,
  `ControlScope = "factory" | "run"`; `RunControlState = { paused, stopped, updatedAt, actor?, reason? }`.
  `performControlAction` records **actor + reason** and retries on optimistic-concurrency
  conflicts.
- **API** (`app/api/dark-factory/control/route.ts`): GET state, POST action, already behind
  `guardOperator` (operator-only auth).
- **UI**: `use-factory-control.ts` POSTs `{ action, scope, runId?, reason? }`;
  `control-panel.tsx` renders Pause/Resume/Stop.
- **The ledger ALREADY has a terminal `abort`**: `RunControlTransition = "abort" | "resume"`
  and `runDarkFactoryDispatch`'s abort branch (`entry.ts:419-520`) claims an abort control
  delivery, HELDs the degenerate cases (already completed / already terminal / duplicate
  targeting an earlier run / duplicate with no eligible run), and reaches a run whose
  **run-history status is `aborted`** (pinned by `entry.test.ts:223,268,485,636`).
- The cooperative enforcement of `stop` already exists: `createControlCheckpoint` throws
  `StoppedRunError`, and the dispatcher records terminal `stopped` with no retry.

## Verified gaps

1. **The failed-run button is a lie.** `control-panel.tsx:114-123` shows **"Resume run"** for
   a failed run and calls `onAction("resume", scope)` — but the control-plane `resume` only
   sets `paused: false`. It **never re-dispatches anything**, so a failed run "resumes" to
   nothing.
2. **No retry action** exists in the API, the service, or the UI.
3. **`stop` vs `abort` is ambiguous.** `stop` sets a `stopped` FLAG in the control store;
   run-history has no `stopped` status at all (its terminal set is
   `succeeded | failed | aborted`). So a plain `stop` can leave the run's ledger status
   unchanged, and the operator cannot tell which terminal state they produced.
4. **The UI's retry is blocked by design elsewhere**: the trigger's re-run guard refuses once
   the issue carries `df:done` / `df:failed` (see #284), so an operator retry must NOT go
   through `decideDarkFactoryTrigger`.

## Intended fix

### Abort — one action, two writes, no new state concept

`abort` is the run-scoped action that means "this run is over, terminally":

- set the run's control state with `stopped: true` + **actor + reason** (reusing the control
  store, which is where actor/reason already live), and
- drive the **existing** ledger abort transition so the run-history status becomes
  `aborted`, using a deterministic delivery identity (`operator-abort:<runId>`) so a
  double-click is idempotent via `claimControlDelivery`.

That is what makes `aborted` distinct from `stopped`: `stop` remains the cooperative,
flag-only action, while `abort` additionally reaches a terminal `aborted` run status.

### Retry — an explicit operator re-dispatch that ignores the re-run guard

`retry` (run-scoped, only meaningful for a failed run) resolves the run's `repo`/`issue`
from run-history and calls `runDarkFactoryDispatch` with a **`trigger` decision built
directly** (not via `decideDarkFactoryTrigger`), under a deterministic
`operator-retry:<runId>` delivery identity.

**Semantics: retry starts a NEW run for the same issue.** Run identity in this ledger is
delivery-bound (a replay of one delivery reuses its run; a distinct delivery gets a fresh
run), so reusing that path is both the smallest change and the honest semantics. The detail
view shows the resulting run id.

### Auth and recording

Both actions ride the existing operator surface: the control route's `guardOperator`, the
`actor` from the viewer, and an optional `reason`. No new auth seam.

### UI

`control-panel.tsx` for a FAILED run shows **Retry** and **Abort** (replacing the misleading
"Resume run"), and the terminal label for each resulting state stays explicit
(`Succeeded` / `Aborted` / `Stopped` / `Failed`). Non-terminal runs keep Pause/Resume/Stop.

## Tasks (TDD, one RED to GREEN cycle each)

- **T1 — control vocabulary + abort.** Extend `ControlAction` with `abort`, add it to the
  route's action guard, and implement the abort path (control state write + ledger abort).
- **T2 — retry.** The operator re-dispatch path, refusing a run that is not failed, and
  refusing (not duplicating) a second retry of the same run.
- **T3 — auth + recording.** Both actions are operator-only and record actor + reason; a
  non-operator gets the same refusal as the existing actions.
- **T4 — UI.** The failed-run panel renders Retry + Abort; the resulting state renders
  unambiguously; the hooks pass the new actions through.
- **T5 — docs + ADR.** An ADR recording the stop-vs-abort decision and the retry semantics
  (new run), plus the index row.

## Files likely to change

- `agent/lib/dark-factory/control.ts` (action vocabulary)
- `agent/lib/dark-factory/control-service.ts` (abort handling)
- `app/api/dark-factory/control/route.ts` (action guard + the retry/abort delegation)
- `app/dark-factory/ui/control-panel.tsx`, `use-factory-control.ts`
- tests: `control-service.test.ts`, `control-panel.test.tsx`, `run-detail-page.test.tsx`, a new route test
- `docs/adr/0023-*.md` + `docs/adr/README.md`

## Validation

- `npx vitest run` (full suite), `npx tsc --noEmit --incremental false`
- `DF_PLATFORM_PROVIDER=generic npm run build`
- cspell, markdownlint, markdown-table-formatter, doc-drift + ADR-integrity guards
- Rebase onto the current `origin/main` immediately before opening the PR

## Risks / open questions — your call

1. **Retry = a NEW run (my proposal) or a new attempt on the SAME run?** A new run reuses the
   delivery-bound identity and the whole trigger path; a same-run attempt would need a new
   attempt concept in the ledger. I recommend a new run.
2. **Abort = `stop` flag + terminal `aborted` (my proposal)?** This is what separates the two
   states. The alternative — collapse them — is what the issue explicitly says to avoid.
3. **Replacing the failed-run "Resume run" button changes existing UI behaviour.** I believe
   it fixes a defect rather than a preference: the current button does nothing observable.
   Confirm you want it replaced rather than kept alongside.
4. **Where the two actions live**: extending the operator control surface (`/control`) keeps
   one auth seam and one vocabulary, but the route gains a run-history dependency for retry.
   The alternative is a separate operator route per action. I recommend extending `/control`.