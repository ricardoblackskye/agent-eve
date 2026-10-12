# Plan — #316: a runner-driven run must create its run record

**Branch:** `feat/df-runner-record-316` (off `origin/main` @ `f6f85b6`)
**Issue:** [#316](https://github.com/ricardoblackskye/agent-eve/issues/316)
**Epic:** #267 · **Date:** 2026-10-11

## Goal

A run driven by `scripts/dark-factory-runner.ts` — the only path that executes the whole
pipeline — must **create its run record** through the existing seam, so it appears in the
dashboard and the events the runner appends attach to a run the ledger actually knows about.

Today it leaves no trace: the configured ledger holds **2 rows, both seeded fixtures**
(#101/#102, exact 09:00/09:15 stamps), and the UI list reads `df_run_summaries`.

## The crux — WHO owns the run identity? (resolved by reading the seam)

- **`acceptDelivery({ deliveryId, repo, issue, receivedAt })` MINTS the run id** via the store's
  internal `idFactory` (`run-history-store.ts:771`). It takes no explicit run id.
- It is **idempotent per `deliveryId`**: a replay returns the **existing** summary with
  `duplicate: true` (lines 747-769), and it **refuses** a replay whose repo/issue differ.
- The runner today invents its own id — `resolveRunnerRunId` -> `run-<issue>-<ts>` — which the
  ledger never sees, and passes it to `buildRunControl(env, runId)`.

**Decision: the ledger owns the run identity and the runner adopts it.** The runner's `--run-id`
becomes the **attempt / delivery** identity; the run id used downstream (control store, ledger
events, handoff, comments) is the one `acceptDelivery` returns.

Why this is the right way round:

- **One identity.** Any other arrangement leaves two, which is the bug we are fixing.
- It also fixes a **second latent bug**: today the runner's control store is keyed on an id the
  dashboard does not know, so a dashboard control action (pause/stop/retry) could never target a
  runner-driven run. Adopting the ledger's id makes those actions addressable.

## Behaviour when the ledger is unconfigured — fail-closed, but honest

`createRunHistoryStore` returns the **console** store when `DF_RUN_HISTORY_DRIVER` is unset, and
its `acceptDelivery` returns `{ ok: false, mode: "blocked" }`. The runner must still be usable
locally, so the behaviour is:

- **log loudly** that the run will **not** be recorded (naming the missing driver), and
- fall back to the attempt id (today's behaviour) so the run proceeds.

Never a silent claim of recording; never a crash. This mirrors the honest no-op the other
unconfigured seams use.

## Tasks (TDD, RED -> GREEN per task)

- **T1** — **identity adoption.** A test proving the runner uses the id the ledger returns, and
  that a **repeated attempt id is a no-op** (`duplicate: true`) returning the **same** run id.
- **T2** — **the unconfigured path**: a blocked `acceptDelivery` logs a clear warning and the run
  continues on the fallback id (asserted: no throw, and the warning is emitted).
- **T3** — **wiring** in `scripts/dark-factory-runner.ts` (accept before the control store is
  built, so the adopted id is what everything downstream uses) plus a **source-level guard** in the
  established runner-wiring style, pinning the call site and the ordering.

## Files likely to change

- `scripts/dark-factory-runner.ts` — the accept step + adopting `value.runId`.
- `tests/dark-factory/…` — the new tests, and the existing runner-wiring guard extended.
- A small **seam module** only if the adoption cannot be exercised without booting the runner; if
  one is added, it needs the catalog row in `docs/pages/dark-factory-modules.md` and the count
  recomputed (`ls -1 agent/lib/dark-factory/*.ts | wc -l`).

## Validation

- `npx vitest run` (full suite), `npx tsc --noEmit --incremental false`
- `DF_PLATFORM_PROVIDER=generic npm run build`
- cspell over **every** changed file (`git diff --name-only origin/main...HEAD` — after committing,
  or the unstaged files are silently skipped); doc-drift + ADR-integrity guards
- The opt-in Postgres integration run, since the deployed adapter mints ids internally
- Rebase onto the then-current `origin/main` **and push the rebase**; confirm
  `git rev-list --count HEAD..origin/main` is 0 and remote HEAD == local
- **Real-world proof**: after the merge, a run should appear in the dashboard runs list — the
  check that closes this issue is the ledger row existing, not just the unit tests.

## Open question for you (the one real decision)

The `--run-id` flag's meaning shifts: **attempt identity, not run identity.** If you would rather
keep `--run-id` as the run's identity, the alternative is extending `AcceptRunDelivery` with an
optional explicit run id — a wider contract change touching the interface, the validator and
**both** adapters. **My recommendation: adopt the ledger's id**, because it is smaller and it is
what makes a runner-driven run controllable from the dashboard.

## Explicitly out of scope

- Notifications (#317 / #318); the `worker-reporter` wiring; the parked-question path.
- Multi-repo / disposable-workspace support (parked).
- Any change to how a *webhook*-driven run is accepted — that path already does this correctly.