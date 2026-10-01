# 0007 — Control state is DB-backed and fail-closed

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

Control actions (halt, resume, dispatch) must hold across requests. An in-process
store would appear to work and then silently lose state on the next request or
instance, which is the worst possible failure for a control plane.

## Decision

Keep control state in a database, selected by `DF_CONTROL_DRIVER`
(`console` / `sqlite` / `postgres`). An unset or invalid driver fails closed.
Control actions carry the expected prior state, so adapters can reject stale
writes.

## Consequences

- A stale action is rejected rather than overwriting a newer decision — two
  operators cannot silently clobber each other.
- Production requires a real adapter; the local drivers are not production
  answers.
- A misconfigured driver halts control rather than permitting actions against an
  unknown state. Losing control is preferable to acting on a wrong picture.
