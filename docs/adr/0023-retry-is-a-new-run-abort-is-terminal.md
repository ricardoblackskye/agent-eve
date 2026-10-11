# 0023 — Retry starts a new run, and abort is terminal where stop is a flag

- **Date:** 2026-10-10
- **Status:** Accepted

## Context

The control plane (#264) offered `pause` / `resume` / `stop`. Two operator needs were unmet:
retrying a failed run, and ending a run terminally in a way distinguishable from `stop`.

The gap was worse than a missing button. `control-panel.tsx` already showed **"Resume run"**
for a failed run and called the control-plane `resume` — which only clears the `paused` flag.
It never re-dispatched anything, so a failed run "resumed" to nothing. And `stop` versus
`abort` was genuinely ambiguous: `stop` sets a flag in the control store, while run-history
has **no `stopped` status at all** (its terminal set is `succeeded | failed | aborted`), so a
stop could leave the run's ledger status unchanged.

The ledger already held the terminal half: `RunControlTransition = "abort" | "resume"`, and
`runDarkFactoryDispatch`'s abort branch reaches a run whose status is `aborted`.

## Decision

- **Retry starts a NEW run.** Run identity here is delivery-bound — a replayed delivery reuses
  its run, a distinct delivery gets a fresh one — so retry re-dispatches through the ordinary
  trigger path under a deterministic `operator-retry:<runId>` delivery identity. It
  deliberately does **not** go through `decideDarkFactoryTrigger`, because the re-run guard
  refuses once the issue carries `df:done` / `df:failed` (#284) and must not block an explicit
  operator action. Retry is refused unless the run actually failed.
- **Abort is `stop` PLUS the terminal ledger transition.** The run-scoped action writes the
  cooperative stop flag with actor + reason (so a still-running run halts at its next
  checkpoint) and then drives the existing ledger abort so the run-history status becomes
  `aborted`. That is precisely what distinguishes `aborted` from a flag-only `stopped`.
- **Abort is offered only while a run can still end.** Aborting an already-terminal run is a
  no-op — the ledger correctly HELDs it — so the detail view offers Abort on a non-terminal
  run and Retry on a failed one, rather than a button that cannot work.
- **Both ride the existing operator surface** (`/api/dark-factory/control`, behind
  `guardOperator`) and both are recorded: abort writes the run's control state (actor +
  reason), retry appends a control event (it changes no state). The ledger keeps only a
  generated, bounded reason — never the operator's free text.
- Repeated clicks are idempotent because the delivery identity is derived from the RUN, so
  `claimControlDelivery` (abort) and `acceptDelivery` (retry) dedupe them.

## Consequences

- Stopping and aborting are genuinely different verbs, and the operator can see which terminal
  state resulted.
- A retry produces a NEW run for the same issue. The old failed run stays `failed` — it is the
  record of what happened — and the detail view shows the new run id.
- Retry's handoff carries the verified identifiers rather than an issue brief, because the
  brief is not stored in the ledger (no-raw-content rule). The factory fetches the live issue
  itself, exactly as the runner does.
- This changes existing behaviour: an operator who pressed "Resume run" on a failed run got a
  flag flip, and now gets a real re-dispatch. That repairs a defect rather than changing a
  preference.