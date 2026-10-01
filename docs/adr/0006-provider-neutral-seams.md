# 0006 — Provider-neutral seams

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

The application deploys on Vercel and uses managed Postgres, but the architecture
must not be locked to either. Vendor SDKs leaking into core logic make a swap a
rewrite rather than a substitution.

## Decision

For each integration, define a canonical payload plus an adapter interface, with a
refuse-default driver. Core code depends on the interface only; no vendor SDK is
imported outside an adapter. The named vendor is swappable by configuration.

## Consequences

- Swapping a provider is an adapter, not a rewrite.
- Core code cannot use vendor-specific features without widening the interface
  first — a deliberate cost that keeps the seam honest.
- Every seam needs a refuse-default driver, so an unset or invalid configuration
  fails closed rather than silently falling back to something unsafe.
