# 78. A re-recorded plan revision is a duplicate, not a failure

**Status:** Accepted
**Date:** 2026-10-29

## Context

The plan ledger is write-once: `UNIQUE (run_id, plan_revision)`, and its contract says so — *"Write-once.
There is no upsert."* Behind that, `recordPostedPlan` rethrows every error that is not a refusing
console/dry-run store, deliberately, because an unrecorded plan is a defect worth failing a run over
(#505).

Those two decisions are each defensible and together they are a landmine. Any second write for a revision
that already exists — a retry, a future call site, a resume whose revision is computed differently — hits
the constraint, propagates through the recorder, and **aborts the run before it can reach coding**.

The resume path is the place this was expected to bite, and today it does not, because a *different*
change guards it: the resume predicate refuses to record a plain resume at all. That is precisely why #516
stayed open — the resume path must not depend on another change to be safe.

## Decision

**The ledger keeps its write-once rule. The recorder absorbs the retry.**

On a rejected write, `recordPostedPlan` reads the run's plans and, if the same plan is recorded at that
revision, reports `{ ok: true, duplicate: true }` with the existing `planId`. Otherwise it rethrows.

- **Catch, then verify — never read first.** There is no extra query on the happy path, and the database
  constraint stays the arbiter, so the race stays closed.
- **Identical means identical.** A *different* plan at the same revision still propagates. Absorbing it
  would hide a genuine re-plan defect: the abort must stay reachable.
- **A duplicate is `ok: true`.** The call was handled and changed nothing. `ok: false` would read as a
  failure and invite the caller to retry the very write the guard exists to prevent.
- **The comparison is canonical, ignoring key order.** jsonb does not preserve key order, and sqlite does;
  a comparison that depends on it is a comparison of storage engines, not of plans.
- **The comment reference is ignored**, for the reason `sameEvent` already records: GitHub derives it after
  the record is written, so it cannot be part of deciding whether two recordings are the same plan.
- **The estimate follows its plan.** A duplicate plan writes no second estimate, because the estimate
  belongs to the plan write this call accompanied.
- **The resume predicate stays.** It avoids a pointless write and a re-price of a plan nobody re-planned;
  the idempotence is defence in depth, not a replacement.

## Consequences

- A resume, a retry or a repeated call site can no longer abort a run by re-recording a plan it already
  recorded, and the ledger still holds exactly one row per `(run_id, plan_revision)`.
- A genuine conflict is still loud, and still costs the run — unchanged.
- `sameEvent` compares `JSON.stringify` over records that may also round-trip through jsonb, so it may
  carry the same latent key-order assumption. Recorded here rather than widened into this change.
