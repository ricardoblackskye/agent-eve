# 0057 — A stale reservation is reaped on admission

- **Date:** 2026-10-24
- **Status:** Accepted

## Context

ADR 0054 shipped three parts. **A** settles the reservation at the call boundary by wrapping
the returned model; **B** reaps reservations that cannot be settled (a process killed
mid-call, a deployment swap, a platform timeout); **C** counts the call at admission so an
admitted-but-unreconciled call stays visible.

A and C have been called in production since #446. **B has not.** `reapStaleReservations` was
implemented in the in-memory, SQLite and PostgreSQL stores and covered by tests, but nothing
in `agent/` or `scripts/` invoked it. It was a backstop with no schedule.

The cost of an unscheduled backstop was measured on 2026-10-24, on the row production reads:

```text
df_cost_budgets   2026-10 orchestrator  cap=30 spent=16.8570 reserved=12.6355 used=29.4925 (98%)
df_cost_reservations WHERE settled = FALSE:  n=27 usd=12.6355 oldest=2026-10-13 newest=2026-10-23
```

`spent_usd` had not moved, so the entire surplus was phantom: 27 reservations no process ever
settled, the oldest eleven days old. With 98% of the ceiling committed and a turn reserving
about $4.86, every turn was refused — and Eve reported the refusal as
`MODEL_SELECTION_FAILED`, which reads as a model or provider fault.

The obvious schedule is a cron job. It is the wrong one here: a cron route cannot see the
runner's local SQLite store, Vercel Cron runs only in Production, and it would add an
endpoint, a secret and a schedule to maintain for a backstop that matters only when a process
dies.

## Decision

Schedule the reaper on the **admission path**. `createCostGovernor().admit()` calls
`store.reapStaleReservations(RESERVATION_TTL_MS)` immediately before it takes its own
reservation, at most once per `REAP_INTERVAL_MS` per governor instance.

- The leak is created only by processes that admit, so the release belongs in the same place.
  Every caller — the deployed agent, the runner, the PR reviewer — inherits it with no new
  deployment surface, no route and no secret.
- Reaping **before** the reservation means the budget it frees is available to the call that
  triggered it. That self-healing order is what the incident needed.
- The throttle is per process, not per turn: a turn pays at most one extra store round trip
  inside any `REAP_INTERVAL_MS` window. The initial value means the first admission in a
  process reaps, so in a serverless runtime cold starts are the schedule.
- The reap is **best-effort**. A store that cannot reap must still report its own admission
  refusal, so a throw is swallowed. A backstop must never veto the call it protects.
- **TTL 30 minutes**, as a stated guess. ADR 0054 already says the TTL is one: too short reaps
  a live call and lets a slow turn overspend, too long strands budget. Thirty minutes sits far
  beyond any single call (Vercel's maximum function duration is 900 s) and far inside the
  eleven days a stranded reservation survived.
- Both values are module constants rather than environment variables. Tuning a safety limit
  should cost a deploy, not an env edit.

## Consequences

- A reservation no process can settle is released at the next admission after the TTL, with no
  operator action. Dead reservations can no longer erode the ceiling into refusals.
- The delay is bounded by traffic: if nothing admits for hours, nothing is competing for the
  budget either, so the delay is harmless.
- A reaped attempt stays visible. Reaping releases the reserve and leaves `call_count` as
  admission recorded it, so the row still shows the call happened and consumed nothing.
- Reaping and settling cannot double-charge: `settle()` opens with
  `if (reservation.settled) return { ok: true }`, so a late settle after a reap is a no-op.
- This does not address genuine spend against a cap, and it does not make a refusal explainable
  in an eval. Both remain separate work.
- The governor must stay the only door to `store.reserve`. A future caller that reserved
  through some other path would admit without reaping, and its stranded reservations would
  wait for someone else's turn.