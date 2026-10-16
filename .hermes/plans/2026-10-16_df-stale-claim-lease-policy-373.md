# Policy proposal — an active-run claim is a LEASE, and only a stale one may be retired

- **Date:** 2026-10-16
- **Status:** PROPOSAL — awaiting your decision, not yet a decision.
- **Related:** 0026 (one active run per repo+issue), 0037 (the target repository is resolved), #373.

> This is a proposal rather than an ADR because the repo's ADR integrity gate accepts only `Accepted` or
> `Superseded by NNNN` — correctly, since an ADR records a decision already taken. On your approval this
> becomes ADR 0039 with status `Accepted` and its index row.

## Context

The claim is what stops two runs working the same issue: `activeRunHolder` treats a row as active when
`status IN ('queued','running','blocked')`, and a partial UNIQUE index is the backstop for a true race.

Nothing releases that claim if a run dies without finalising. A crash, a Ctrl-C, or an error that bypasses
the terminal path all leave the row active **forever**, and every later run for that repo+issue is then
refused as a duplicate delivery.

That is not hypothetical. It is what the #373 UAT hit on WebFeedPOC#161: a row created at 11:56 was still
`queued` hours later; the attempt at 12:07 was refused the delivery, fell back to a synthetic run id, and its
lifecycle writes therefore targeted a different id — so the stale row kept the claim, the issue became
permanently un-runnable, and (before #373's fix) the warning blamed a driver that was correctly configured.
The block was invisible: nothing in the output said a run was holding it.

## Decision

Treat an active claim as a **lease**, not a lock.

1. **The lease is `updated_at` plus `DF_RUN_CLAIM_LEASE_SECONDS`** (default 1800). A claim whose row has not
   moved within its lease is **stale**. Stage transitions already move `updated_at`, so a live run refreshes
   its own lease as a side effect of making progress; no new heartbeat mechanism is needed.
2. **Only a stale claim may be retired**, and retiring is an explicit, recorded transition: status `aborted`,
   stage `terminal`, `completed_at` and `updated_at` set, plus a `run.terminal` event whose eventId names the
   repair. This is the shape #328's `repairActiveRunDuplicates` already uses, so the ledger's timeline
   explains itself rather than showing a run that silently vanished.
3. **One mechanism, not two.** The manual path is the existing operator `abort` action (#307), which already
   drives the ledger's abort transition and produces the `aborted` status. The automated reaper performs the
   same transition, so a human and the reaper cannot disagree about what retiring means.
4. **A non-stale claim is a hard refusal.** The runner must not start against a claim inside its lease. It
   stops, names the holder and its status, and says what to do. What it must never do is what it did before:
   proceed anyway with a synthetic run id and write its lifecycle to a phantom run.
5. The runner may retire **only** a claim past its lease, and when it does, it says so on the ticket.

## Consequences

- A crashed run self-heals after its lease, and the ticket explains what happened. Today it blocks the issue
  permanently and silently.
- The common case needs no human. The residual case — a genuinely live run that exceeds its lease — is a
  signal to raise the lease, not to disable the mechanism.
- **A lease is a timeout, so it is wrong sometimes.** A live run in a long coding phase can exceed it. That is
  the accepted cost of not being able to observe a process on another host, and it argues for a generous
  default and for making the value configurable per repository (0038's config is the place).
- Tests must pin: retirement only past the lease; the transition is recorded; the reaper is idempotent; and a
  live claim is left strictly untouched.
- This does not release the claim when a run fails *cleanly* — that path already works, via the terminal
  event, and #373 proved it. This record is about the runs that never reach it.
