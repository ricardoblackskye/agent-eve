# Tenant attribution and reporting

Every Dark Factory run belongs to a tenant, and that ownership is recorded exactly
once. This page covers **write-once attribution** and why the system is built that
way. The cost side of "who pays" is in
[cost and usage governance](flow-cost-governance.md).

## Why write-once

Tenant attribution is **write-once**
([ADR 0001](../../docs/adr/0001-tenant-attribution-is-write-once.md)). Once a run
is attributed to a tenant, that fact cannot be edited or overwritten — not by a
replay, not by an operator, not by a later code change. The rationale is
irreversibility: billing, quotas, and audit trails all depend on the attribution
of a past run being stable. A mutable attribution would let a replay silently
re-credit or re-blame a tenant, which is unacceptable for anything that feeds
billing.

## How it is recorded

[`run-attribution.ts`](../../agent/lib/dark-factory/run-attribution.ts) writes the
attribution as part of the run's transition set. The three identities stay
distinct
([`run-history.ts`](../../agent/lib/dark-factory/run-history.ts)): the GitHub
**delivery ID** deduplicates redelivery, the opaque **run ID** identifies the
execution, and the stable **event ID** identifies each lifecycle transition. A
replayed trigger delivery reuses its bound run; a distinct trigger delivery gets a
fresh run ID. Replaying an identical event is a no-op; a reused event ID with
different contents is rejected.

## The registry is ours; the CRM is bought

The tenant registry is owned by the factory, while CRM-style customer data is a
bought system
([ADR 0008](../../docs/adr/0008-tenant-registry-is-ours-crm-is-bought.md)). The
seam is [`tenant.ts`](../../agent/lib/dark-factory/tenant.ts) with store adapters
([`tenant-store.ts`](../../agent/lib/dark-factory/tenant-store.ts),
`tenant-store-{sqlite,postgres}.ts`) selected by driver, never by a vendor SDK
([ADR 0006](../../docs/adr/0006-provider-neutral-seams.md)).

## Reporting

Tenant-scoped usage and cost roll-ups are read through
[`tenant-usage-query.ts`](../../agent/lib/dark-factory/tenant-usage-query.ts) and
surfaced in the
[`tenant-usage-panel.tsx`](../../app/dark-factory/ui/tenant-usage-panel.tsx) UI and
the [`tenants` API route](../../app/api/dark-factory/tenants/route.ts). The
aggregate API returns **counts only** — raw finding text is never returned to a
viewer, consistent with the honesty rules in
[observability](flow-observability.md).

> Attribution is recorded in the same change that makes the decision, alongside the
> ADR that justifies it — a retrospective attribution is a reconstruction and loses
> the real trade-offs.
