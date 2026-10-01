# 0001 — Tenant attribution is write-once

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

Dark Factory runs are attributed to a customer tenant so usage and cost can be
reported per customer. Repositories change hands: a repo attributed to one tenant
today may belong to another in six months. Reporting must remain truthful about
who the work was done for at the time.

## Decision

Resolve the tenant from trusted server-side repository configuration when a run is
accepted, then persist it on the run as an immutable property. Later lifecycle
events must not rewrite it — enforced structurally by omitting `tenant_id` from
the SQLite `ON CONFLICT ... DO UPDATE` clause and from the Postgres
`updateSummary` SET list.

## Consequences

- Historical attribution is stable: reassigning a repository never rewrites past
  reports.
- A mis-assignment cannot be fixed by editing the current mapping. Correcting it
  requires a deliberate operator action against the run record.
- Reporting must tolerate runs with no tenant. Those are reported as
  unassigned — an explicit state, never inferred from today's mapping.
