# Plan — #317: the notification seam (canonical payload + fail-closed default + lifecycle wiring)

**Branch:** `feat/df-notify-seam-317` (off `origin/main` @ `c1c019c` — the #316 merge)
**Issue:** [#317](https://github.com/ricardoblackskye/agent-eve/issues/317) — split **a** of 2 from #274
**Epic:** #267 · **Date:** 2026-10-11

## Goal

A run transition must reach a human **without them watching GitHub**. The GitHub labels and comments
already exist — they are the record ON the ticket and reach only someone already looking. This adds
the missing **out-of-band push**, with **no vendor named or required** (that is #318).

## The two patterns to mirror (do not invent a third)

1. **The driver/factory seam** — `usage-store-provider.ts`: a provider interface + adapters, a
   `createX(env)` selected by a `DF_*_DRIVER`, a **fail-closed default**, and an
   `isXConfigured(env)` helper so "an unconfigured deployment pays no cost and writes no events".
2. **The decorator** — `RunHistoryWorkerReporter` (`worker-reporter.ts`): wraps an inner provider
   plus the run-history store, **persists first** (fail-closed) and performs the external action
   afterwards, deriving the reference last.

## Design

### Hook: decorate the run-history store, do not add call sites

Every write path — the webhook dispatch, `worker-reporter`, the runner, `run-finalizer`, and the
breaker-trip recorder — reaches the ledger through **`RunHistoryStore.appendEvent`**. So a
**decorating store** (`NotifyingRunHistoryStore`) inspects each appended event and emits a
notification for the transitions that matter. No lifecycle site gains a call, and no path can be
forgotten — which is exactly how the last three dead seams happened.

### The transition map (closed, from the existing event vocabulary)

| Appended event | Notification kind |
| :--- | :--- |
| `run.accepted` | `started` |
| `run.terminal` + status `succeeded` | `succeeded` |
| `run.terminal` + status `failed` | `failed` |
| `run.terminal` + status `aborted` | `aborted` |
| `worker.question` | `parked` |
| any event carrying `breakerTrip` | `tripped` |

### Idempotency — use the ledger's own dedupe

`RunHistoryWriteResult` carries **`duplicate?: boolean`**, and the ledger is already idempotent per
`(runId, eventId)`. So the decorator emits **only when the append was not a duplicate** — the
transition identity is the event's own id, not invented state. *(Verify that `appendEvent` actually
populates `duplicate` for a replayed eventId; if it does not, fall back to a bounded in-process
notified-set keyed on eventId, and DOCUMENT the boundary — one notification per transition within a
process. I will confirm this before implementing, and the plan will be updated if it changes.)*

### The payload (bounded, machine-readable, no secrets)

`{ kind, runId, repo, issue, status, stage, reasonCode?, prUrl?, occurredAt }` — and nothing else.
**No issue body, no answer text, no `DF_*` value**: the run-history no-raw-content rule applied to a
second egress point, enforced by a test.

### Fail-closed, but honest

- OPT-IN: with no driver configured, the default is a **no-op provider that reports "not
  configured"** — it never claims a delivery it did not perform, and never throws.
- A provider failure is **logged and swallowed**: a notification can never fail a run (mirroring the
  usage-ledger best-effort rule).
- An **unknown driver THROWS** (`NotificationConfigurationError`), so a typo surfaces instead of
  silently losing notifications — the `usage-store-provider` convention.

## Tasks (TDD, RED -> GREEN per task)

- **T1** — the canonical payload + validator (bounds, closed `kind` vocabulary, the no-secret and
  no-raw-content rules) and the fail-closed no-op default.
- **T2** — `createNotificationProvider(env)` / `isNotificationsConfigured(env)`: unset => no-op,
  unknown driver => throws, a real driver selected by env.
- **T3** — the decorating store: each transition in the map emits **exactly once**; a duplicate
  append does not re-emit; a provider failure does not fail the run (and is logged).
- **T4** — wiring + a source-level guard pinning that the provider is constructed in one place and
  that the decorator wraps the store where the app builds it.

## Files likely to change

- `agent/lib/dark-factory/notifications.ts` (**new**) — payload, provider interface, no-op default,
  factory, `isNotificationsConfigured`.
- `agent/lib/dark-factory/notifying-run-history.ts` (**new**) — the decorating store.
- The composition point that builds the run-history store (so the decorator is actually applied —
  the wiring guard must prove it, or this ships as a fourth dead seam).
- `docs/pages/dark-factory-modules.md` — two catalog rows, count recomputed
  (`ls -1 agent/lib/dark-factory/*.ts | wc -l`; currently 78).
- Tests; possibly a short ADR (a new egress point for run data is worth recording).

## Validation

- `npx vitest run` (full suite), `npx tsc --noEmit --incremental false`,
  `DF_PLATFORM_PROVIDER=generic npm run build`
- cspell over **every** changed file (`git diff --name-only origin/main...HEAD` **after committing** —
  otherwise unstaged files are silently skipped); doc-drift + ADR-integrity guards
- Rebase onto the then-current `origin/main` **and push the rebase**; confirm
  `git rev-list --count HEAD..origin/main` is 0 and remote HEAD == local
- **Non-vacuity**: prove the decorator test fails if the wiring is removed (the lesson from #269)

## Explicitly out of scope

- The Slack adapter (#318) and email; inbound notifications; a preferences UI.
- Replacing the `df:*` labels or the ticket comments — they exist and stay.
- The unwired `worker-reporter` and the parked-question path (separate findings).

## Open question for you

**The hook.** I propose the **decorating store**, because it covers every write path and cannot be
forgotten. The alternative is explicit calls at each lifecycle site (webhook dispatch, runner,
finalizer, trip recorder) — more code, and it re-creates the "did every path remember?" risk. Unless
you redirect, I will take the decorator.
