# Control plane and gates

The Dark Factory's **control plane** is the layer that decides whether a run's
outcome is allowed to proceed — open the PR, publish the story, ship the result.
It is deliberately separate from the worker (which only *executes* tasks) and from
run history (which only *records*). This separation is why a gated outcome can
never be persisted as if it were a dispatch record.

## Control state is DB-backed and fail-closed

Control state lives in
[`control.ts`](../../agent/lib/dark-factory/control.ts) and is served by
[`control-service.ts`](../../agent/lib/dark-factory/control-service.ts) /
[`control-postgres.ts`](../../agent/lib/dark-factory/control-postgres.ts), selected
by `DF_CONTROL_DRIVER`. The default refuses rather than silently degrading —
[ADR 0007](../../docs/adr/0007-control-state-is-db-backed.md). An unset driver is
not "in-memory best effort"; it is a hard refusal, because a control decision made
against a store that may vanish is worse than no decision.

## Drivers

Every control capability follows the provider-seam pattern
([ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)): a canonical payload,
a provider interface, and concrete adapters (`console` / `sqlite` / `postgres`)
selected by `DF_*_DRIVER`. The full seam/adapter matrix is generated from `agent/lib/dark-factory/**` — see
[`app/documentation/reference/generators.ts`](../../app/documentation/reference/generators.ts). Picking the wrong
driver fails closed, not open.

## Gated outcomes

A **gated outcome** is a control decision that must be explicitly allowed before
the run's effect (e.g. a published story or an opened PR) is released. Gating is
never the worker's job: the worker reports what it did; the control plane decides
whether that result is permitted to leave the factory. The canonical example is
story publishing, which is fail-closed
([ADR 0004](../../docs/adr/0004-story-publish-is-fail-closed.md)) — a story is
refused unless the allow-list is explicitly configured.

## Optimistic concurrency

Control actions carry the **expected prior state** of the run. Adapters reject a
write whose prior state does not match, so two concurrent control decisions cannot
both "win" a transition. This is what makes the control plane safe to drive from
both the operator CLI
([`operator-cli.ts`](../../agent/lib/dark-factory/operator-cli.ts)) and the UI
([`app/dark-factory/ui/control-panel.tsx`](../../app/dark-factory/ui/control-panel.tsx))
at the same time.

## Checkpoints

[`control-checkpoint.ts`](../../agent/lib/dark-factory/control-checkpoint.ts)
records durable checkpoints so a control decision survives a restart and a replay
cannot re-apply an already-applied gate. Replaying an identical checkpoint is a
no-op; a reused checkpoint ID with different contents is rejected — the same
honesty rule that guards run history.

The operator surface for all of this is the progress board (see
[observability](flow-observability.md)) and the `operator-cli`.
