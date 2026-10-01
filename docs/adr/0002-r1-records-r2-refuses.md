# 0002 — R1 records and reports; R2 refuses

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

Attribution (R1) and budget enforcement (R2) were delivered as separate releases.
When R1 landed, operators were already running work and the tenant seed had not
been applied everywhere.

## Decision

R1 records and reports usage per tenant without blocking anything. Enforcement —
refusing a run — arrives in R2, once attribution is complete.

## Consequences

- Existing operator work continues uninterrupted through R1; nothing that used to
  run starts failing because a tenant could not be resolved.
- There is a window in which a tenant can exceed its eventual cap without being
  stopped. That is accepted deliberately, and is the reason R1 and R2 are separate
  releases rather than one.
- Enforcement must be able to distinguish "no tenant assigned" from "tenant over
  budget", because only the latter should refuse.
