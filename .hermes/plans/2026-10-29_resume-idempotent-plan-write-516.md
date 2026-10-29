# A re-recorded plan revision is a duplicate, not a failure Implementation Plan (#516, epic #453)

> **For Hermes:** execute with the repo's own TDD discipline (RED -> GREEN per task, separate
> commits), then stop at GATE 2 for PR authorization.

**Goal:** make the resume path safe **on its own**. Today it is safe only because a *different* change
guards the call: anything that re-records the same `(run_id, plan_revision)` hits a write-once ledger,
the recorder rethrows by design, and the run aborts before it can reach coding.

**Architecture:** the ledger stays write-once — that rule is deliberate and ADR'd. The **recorder**
absorbs the retry instead: an identical plan for the same revision is recognized as the write that
already happened, reported as a duplicate and treated as success. A *different* plan at the same revision
is still an error.

**Tech Stack:** TypeScript, Vitest, the existing ledger and recorder, no new dependency.

---

## Verified findings (the reconnaissance this plan rests on)

### The defect is a landmine, and the issue says so itself

`#516` records that the trigger is already removed — "`#487`'s guard (`!isResume || isRevision`) makes a
plain resume record nothing" — and keeps the issue open for the **standalone defect**: the resume path
must not depend on another change to be safe. That guard is in place today
(`scripts/dark-factory-runner.ts:971`, `shouldRecordPlanEstimate({ resuming: isResume, revision: isRevision })`).

What remains is the failure mode behind it:

| where                                                      | what                                                                                                                          |
|------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------|
| `agent/lib/dark-factory/plan-ledger.ts:18`                 | *"Write-once. There is no upsert."*                                                                                           |
| `agent/lib/dark-factory/run-history-postgres.ts:1427`      | `recordPlan` is a bare `INSERT ... RETURNING plan_id`, no `ON CONFLICT`                                                       |
| `agent/lib/dark-factory/plan-revision-recorder.ts:218-224` | every error that is not a `RunHistoryConfigurationError` is **rethrown**, so a unique violation propagates and the run aborts |

So any second write for the same revision — a retry, a future call site, a resume whose revision is
computed differently — is fatal rather than harmless. Nothing observes the collision yet; the issue is a
code-path finding awaiting its live proof, and both halves are in scope here.

### The repo already solved this problem once, and the precedent is exact

`run-history-store.ts:424` — `sameEvent` — compares two records by JSON equality so that a re-append of
the same event is a no-op instead of a duplicate-key error, deliberately ignoring the `commentReference`
because it is **derived from GitHub after the event is recorded**. A plan's `commentRef` is derived the
same way, in the same order, so the same exception applies for the same reason.

The result shape to follow is also already in the codebase: `ok: true` with `duplicate: true` means *this
call was handled and changed nothing* — never `ok: false`, which would invite the caller to retry the very
action the guard exists to prevent.

## Global constraints

- **The ledger stays write-once.** No upsert, no `ON CONFLICT`, no schema change: the constraint is the
  arbiter, and the fix belongs on the caller's side of it.
- **The collision is detected by CATCHING, not by reading first.** The happy path costs no extra query, and
  the race stays closed because the constraint decides.
- **Identical means identical.** A different plan for the same revision is still an error — silently
  accepting it would hide a genuine re-plan defect.
- **The guard stays.** It avoids a pointless write and a re-price of a plan nobody re-planned; the new
  idempotence is defence in depth, not a replacement.
- No content in any report: ids, revisions and counts only.

## Review focus

- **A duplicate must be a success and a conflict a failure** — assert both on the same fixture shape, so a
  helper that returns `true` unconditionally cannot pass.
- **The derived `commentRef` must not make two recordings differ.** Assert a re-record whose comment
  reference changed is still recognized as the same plan, mirroring `sameEvent`'s stated reason.
- **The estimate must not be re-inserted behind a duplicate plan.** A duplicate plan means the estimate was
  written by the same seam, so asserting the write count proves the whole write is idempotent rather than
  half of it.
- **An abort must remain reachable.** A plan that genuinely differs must still propagate, or the fix would
  have traded one silent failure for another.

## Tasks

### Task 1 — the comparison

**Files:** modify `agent/lib/dark-factory/plan-revision-recorder.ts`, test
`tests/dark-factory/plan-revision-recorder.test.ts` (extend).

```ts
/** Whether a recorded plan is the same plan, ignoring the comment reference GitHub gives us afterwards. */
export function samePlan(left: ExecutionPlan, right: ExecutionPlan): boolean;
```

RED: identical plans match; a changed task, target file or rationale does not; a differing `commentRef` is
ignored, with the reasoning in a comment (the same reason `sameEvent` gives).

### Task 2 — the recorder absorbs the retry

**Files:** modify `agent/lib/dark-factory/plan-revision-recorder.ts`, test as above.

On a thrown write that is not a configuration error, read the run's plans, find the same revision, and if
the plan is the same return `{ ok: true, planId, duplicate: true }`; otherwise rethrow. RED: an identical
re-record is a duplicate success; a differing one still throws; a configuration error is still `skipped`.

### Task 3 — the estimate follows the plan

**Files:** modify `agent/lib/dark-factory/plan-estimate-recorder.ts`, test
`tests/dark-factory/plan-estimate-integration.test.ts` (extend).

A duplicate plan reports the duplicate and writes no second estimate — the estimate belongs to the plan
write it accompanied, and re-pricing it would breach the same rule the guard exists to honour.

### Task 4 — the live proof

**Files:** `tests/dark-factory/resume-plan-write.test.ts` for the forced collision.

Two proofs, because the issue asks for observation and the defect is a landmine:

1. **Forced collision:** drive the recorder twice for the same revision through a real store, and show the
   second returns a duplicate rather than aborting; then with a *different* plan, and show it still throws.
2. **A real park and resume** if the local plumbing allows it (the runner takes a resume path); if it does
   not, say so explicitly rather than implying the run was resumed.

### Task 5 — ADR 0078 and docs

**Files:** create `docs/adr/0078-a-re-recorded-plan-revision-is-a-duplicate.md`, modify
`docs/adr/README.md` and the docs page that owns the plan ledger.

Records: the ledger stays write-once; the retry is absorbed by the recorder; the comparison ignores the
derived comment reference for the reason `sameEvent` already gives; and a differing plan remains fatal.

---

## Validation

- Full suite green with no new failures, `tsc --noEmit --incremental false` clean, every pinned linter
  clean locally on the changed files.
- **The Postgres legs must RUN** in that validation, not skip: export the `DF_*_TEST_DATABASE_URL`
  variables, because a skipped leg is what let a CI-only failure ship on #533.
- Unset the run-time `DF_*` exports (the non-test ones) before validating, or the suite lies.

## Settled decisions (agreed at GATE 1)

1. **The recorder absorbs the retry.** The ledger keeps its write-once rule and stays the arbiter; no
   upsert, no `ON CONFLICT`, no schema change. An upsert would silently accept a DIFFERENT plan at the same
   revision, which is precisely the failure a write-once rule exists to surface.
2. **The same plan is JSON equality, ignoring the derived `commentRef`** — mirroring `sameEvent`, for the
   reason that helper already gives: GitHub derives the reference after the record is written, so it must
   not make two recordings of one plan look different.
3. **A duplicate is `ok: true` with `duplicate: true`.** The call was handled and changed nothing. A
   refusal would read as a failure and invite the caller to retry the very action the guard prevents.
4. **The #487 guard stays**, and the idempotence is added alongside it: defence in depth. The guard still
   avoids a pointless write and a re-price of a plan nobody re-planned.
5. **The live proof has two halves**: the forced collision through a real store, and a real park-and-resume
   if the local plumbing allows it — with the limitation stated plainly if it does not.

## Risks that remain

- **A differing plan at the same revision still aborts the run.** That is deliberate: it is a real defect
  surfacing, and the alternative is a fix that trades a loud failure for a silent one.
- **The comparison is by content, so a genuinely re-planned revision must change its revision number.** The
  resume path already computes revisions; this does not add a second opinion about what a revision is.
