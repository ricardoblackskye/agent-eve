# An unmeasured counter reports as unmeasured, never as zero (#716)

**Issue:** [agent-eve#716](https://github.com/ricardoblackskye/agent-eve/issues/716) (`bug`)
**Branch:** `fix/716-unmeasured-counters` (off `origin/main` @ `5768907`)
**Status:** plan for GATE 1 - no code written yet.

**Goal:** make `iterationCount` and `fixCycleCount` report what was actually observed, so a reader can tell
*unmeasured* from *genuinely zero* - and supply the values from the one place that already knows them.

---

## Context

The contract is already written, in `agent/lib/dark-factory/definition-of-done.ts:331`:

```ts

/** Only provide metrics observed by the caller; omitted values stay unmeasured. */
runMetrics?: Pick<RunEvent, "iterationCount" | "fixCycleCount" | "latencyMs" | "costUsd">;
```

Nothing supplies it, and the write paths turn the omission into `0`. Measured on the local ledger, all six runs
report `iteration_count = 0` and `fix_cycle_count = 0` - **including `WebFeedPOC#241` (run `18c58665`), whose log
shows `Coding Iteration 2/10` and two files written across iterations.** So a run that demonstrably iterated is
recorded as having iterated zero times, and the run-details page renders it as measured fact.

## Fault chain (verified, with the lines)

1. **The runner never supplies the metrics.** `runMetrics` appears only in `definition-of-done.ts` - the grep over
   `agent/`, `scripts/` and `app/` finds it nowhere in `scripts/dark-factory-runner.ts`, which is the only place
   that knows the iteration index.

2. **The attempt summary fabricates the values.** `agent/lib/dark-factory/run-attempt-summary.ts:38-39`:

   ```ts
   iterationCount: input.iterationCount ?? 0,
   fixCycleCount: 0,
   ```

   `fixCycleCount` is hardcoded; `iterationCount` defaults to zero.

3. **The Postgres summary does the same.** `agent/lib/dark-factory/run-history-postgres.ts:898-899` and `:984` -
   both write `iterationCount: 0, fixCycleCount: 0` unconditionally (read at those lines, not inferred).

**The plumbing works.** The Definition of Done's own test feeds `runMetrics: { iterationCount: 3, fixCycleCount: 1 }`
and the summary records 3 and 1. Only the supply is missing - so this is a wiring and honesty fix, not new
machinery.

## Unverified - to confirm first, not to assume

- **Where the run-summary schema lives.** `grep -rn "iteration_count\|fix_cycle_count" db/migrations/` returns **no
  matches**, so the table is either defined elsewhere or the SQL names differ from the TypeScript fields. Whether a
  migration is needed to let these columns hold NULL depends on the answer, so the first task is to find it - not to
  write a migration on a guess.

- **`attempt_count` is 0 on every run too.** The issue asks for this to be confirmed rather than assumed; it comes
  from the same writer, and "no retry attempt was made" is a plausible and different claim from "unmeasured".

## Proposed approach

**A. Stop fabricating.** Remove the `?? 0` and the explicit `0` from the write paths whose own contract says an
omitted value stays unmeasured. An unobserved metric must be written as unmeasured (NULL / absent), not as zero.

**B. Supply what the loop already knows.** Pass `runMetrics` from `scripts/dark-factory-runner.ts` at the
DoD/attempt boundary, where the coding loop's iteration index and the fix cycle's count are in scope.

**C. Keep absent as absent end to end.** The view-model renders the absent marker (`-`) rather than an inferred
zero - the rule #698 leg C applied in the UI, and #384 AC4 states as *"an unavailable metric reports as
unavailable, never as zero"*.

Doing A without B would replace a wrong number with a missing one; doing B without A would leave the fabricated
defaults in place for every path that does not supply the value. Both, or the contradiction survives.

## Tasks (TDD for each)

### Task 1 - RED: an unmeasured counter must not be recorded as zero

- A summary built from an attempt with **no** observed metrics records `iterationCount`/`fixCycleCount` as
  unmeasured, not `0`.

- **Control:** the same path with `{ iterationCount: 3, fixCycleCount: 1 }` still records `3` and `1`, so the check
  cannot pass by ignoring input.

- Expected RED: fails today because both are `0` either way.

### Task 2 - RED: the Postgres write path must not default to zero

- Drive both sites named in fault chain 3 and assert the persisted value for an unmeasured metric is unmeasured.

- Expected RED for the same reason; this is the second site so it cannot be fixed by accident in one place only.

### Task 3 - GREEN: remove the fabrication

- `run-attempt-summary.ts`: drop `?? 0`, and stop hardcoding `fixCycleCount: 0`.

- `run-history-postgres.ts`: stop writing explicit zeros at both sites.

- Widen the types so "unmeasured" is representable, and confirm against the schema located in the unverified step
  whether a migration is required.

### Task 4 - GREEN: supply the metrics from the runner

- Pass `runMetrics` at the DoD/attempt boundary in `scripts/dark-factory-runner.ts` from the loop's own counters.

- **Pin the join, not just the pieces:** a wiring guard asserting the runner passes `runMetrics`, because a feature
  whose parts are each tested can still be inert. This is the failure mode that produced the issue in the first
  place - a contract nothing calls.

### Task 5 - confirm `attempt_count` and record the answer on the issue

- Establish whether `0` is correct or fabricated, and say which on #716 rather than leaving it implied.

### Task 6 - the live check

- A run's ledger row must show a count that **matches its own log** (`Coding Iteration 2/10` -> 2), or an unmeasured
  marker - never a zero that contradicts the log it sits beside.

## Files likely to change

- `agent/lib/dark-factory/run-attempt-summary.ts` - fault chain 2.

- `agent/lib/dark-factory/run-history-postgres.ts` - fault chain 3, both sites.

- `agent/lib/dark-factory/run-history.ts` - the types at `:80-81` and `:108-109`.

- `scripts/dark-factory-runner.ts` - the supply.

- The run-summary schema, once located.

- The run-details view-model if it must render the absent marker.

- Tests: a new `tests/dark-factory/unmeasured-counters-716.test.ts` plus the existing summary/ledger suites.

## Verification

- RED and GREEN committed separately, each with its control case.

- `tsc --noEmit` exit 0; the full suite in the gate's mode with the six `DF_*_TEST_DATABASE_URL` set; the coverage
  ratchet.

- The live check in Task 6 - a ledger row that agrees with the log beside it.

## Risks

- **`plan-history.ts` sums these counters** (`revisionFactorFor`), and a fabricated `0` already defeats it. It
  already has a `usableCounter()` concept, so the exclusion of unmeasured rows must be checked rather than assumed
  to work once NULLs appear.

- **Existing rows keep their zeros.** A migration cannot tell which historical zero was fabricated; the honest
  outcome is that old rows stay as they are and the fix applies from here, which should be said in the PR rather
  than presented as a backfill.

- **NULL versus 0 is a schema decision with read-path consequences** for every consumer of the summary.

## Out of scope

- **#704** (the run diff and worker checkpoints) - a separate defect from the same run-details family.

- Any change to what the counters MEAN; this is about whether they are measured at all.
