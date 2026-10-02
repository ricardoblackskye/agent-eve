# Invariants

An invariant is a property the system holds by construction — the rules a new
developer must not break. Each is stated plainly, with its rationale and a link to
the code (and ADR) that enforces it. The [glossary](glossary.md) defines the
terms used here; the ADRs record *why* each decision was made.

## Invariant: tenant attribution is write-once

A run's tenant is recorded exactly once and never overwritten — not by a replay, an
operator, or a later code change. **Rationale:** billing, quotas, and audit trails
depend on past attribution being stable; a mutable attribution would let a replay
silently re-credit or re-blame a tenant
([ADR 0001](../../docs/adr/0001-tenant-attribution-is-write-once.md)). **Enforced
by**
[`run-attribution.ts`](../../agent/lib/dark-factory/run-attribution.ts), which
deliberately omits `tenant_id` from its `ON CONFLICT` so a re-insert cannot change
the owner.

## Invariant: story publish is fail-closed

A story is never published unless `STORY_ALLOWED_REPOS` is explicitly configured
for the target repo. **Rationale:** an unconfigured allow-list must not default to
"publish everywhere"
([ADR 0004](../../docs/adr/0004-story-publish-is-fail-closed.md)). **Enforced by**
the story-publish seam, which refuses when the repo is outside the allow-list.

## Invariant: an unmeasured value is never zero

Absent latency or cost stays absent; an explicitly measured zero is preserved and
rendered as an em dash (`—`), never `0`. **Rationale:** "we didn't measure it" must
not be mistaken for "it cost nothing"
([ADR 0003](../../docs/adr/0003-unmeasured-is-never-zero.md)). **Enforced by** the
run-history projection and the progress-board view-model, which render `—` for
unmeasured fields.

## Invariant: SQLite is local-only

The SQLite store is rejected when `NODE_ENV=production` or the deployment stage is
`preview`/`production`. **Rationale:** a Vercel function's filesystem is ephemeral;
durable persistence needs PostgreSQL
([ADR 0005](../../docs/adr/0005-sqlite-is-local-only.md)). **Enforced by**
`run-history-sqlite.ts`, which refuses to open outside local development.

## Invariant: seams are provider-neutral with a fail-closed default

Every capability is a canonical payload + provider interface; the `console`
adapter refuses rather than silently degrading. **Rationale:** any Vercel/provider
bit must be swappable in config, with no vendor locked into the code
([ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)). **Enforced by** the
`*-provider.ts` selection logic, which fails closed on an unset/unknown driver.

## Invariant: control state is DB-backed and fail-closed

The control plane's state lives in a store selected by `DF_CONTROL_DRIVER`; an
unset driver is a hard refusal, not in-memory best effort. **Rationale:** a control
decision made against a store that may vanish is worse than no decision
([ADR 0007](../../docs/adr/0007-control-state-is-db-backed.md)). **Enforced by**
[`control.ts`](../../agent/lib/dark-factory/control.ts) and
[`control-service.ts`](../../agent/lib/dark-factory/control-service.ts).

## Invariant: R1 records and reports; R2 refuses

The R1 foundation records run state and reports; the R2 worker refuses to run
anything it is not explicitly configured for. **Rationale:** a factory that
silently executes unconfigured work is unsafe
([ADR 0002](../../docs/adr/0002-r1-records-r2-refuses.md)). **Enforced by**
[`state.ts`](../../agent/lib/dark-factory/state.ts) (records) and
[`worker-env.ts`](../../agent/lib/dark-factory/worker-env.ts) (refuses out-of-allow-list
repos before provisioning).

## Invariant: webhook delivery is deduplicated

A re-delivered webhook cannot double-dispatch work; a distinct trigger delivery
gets a fresh run. **Rationale:** at-least-once delivery must not create duplicate
executions. **Enforced by**
[`dispatch.ts`](../../agent/lib/dark-factory/dispatch.ts), which reads the existing
state record first and never invokes the handler twice for the same delivery ID.

## Invariant: control actions are optimistic-concurrency safe

A control write carries the expected prior state; a mismatch is rejected.
**Rationale:** the operator CLI and the UI may drive the same run concurrently.
**Enforced by**
[`control.ts`](../../agent/lib/dark-factory/control.ts), which rejects writes whose
prior state does not match.

## Invariant: the worker holds a lease, never the operator token

The worker sandbox receives an opaque lease ID and nothing else; the real token is
a `#private` field unreachable by enumeration or serialisation, and lease issuance
is not routable. **Rationale:** "MUST NOT deliver a broad PAT to any worker sandbox"
holds by construction
([ADR 0004](../../docs/adr/0004-story-publish-is-fail-closed.md)). **Enforced by**
[`credentials.ts`](../../agent/lib/dark-factory/credentials.ts) and
[`worker-env.ts`](../../agent/lib/dark-factory/worker-env.ts), which revoke the
lease on every teardown path.
