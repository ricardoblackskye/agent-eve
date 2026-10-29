# Run-level actual cost Implementation Plan (#531, epic #453)

> **For Hermes:** execute with the repo's own TDD discipline (RED -> GREEN per task, separate
> commits), then stop at GATE 2 for PR authorization.

**Goal:** populate `df_run_summaries.cost_usd`, the column `df_plan_estimate_accuracy` reads, so the
view returns rows instead of zero — without under-reporting spend and without counting any call twice.

**Architecture:** one PURE definition of what a run cost, summed from the sources the run already
records; a NARROW, race-safe store write mirroring `updateCommentReference`; and one best-effort call
site at the runner's end of life, so a run's spend is recorded whatever its outcome.

**Tech Stack:** TypeScript, Vitest, the existing run-history and usage stores, no new dependency.

---

## Verified findings (the reconnaissance this plan rests on)

### The row exists; only the value is missing

- The run row is created at ACCEPTANCE — `run-history-postgres.ts:575` says so in as many words:
  "The run row is created at ACCEPTANCE, so `recordRunSummary` ... always targets a row that already
  exists." So a cost can be written at any point after acceptance.
- The summary upsert already writes `cost_usd` (`run-history-postgres.ts:592`, sqlite twin at
  `run-history-store.ts`), but its ONLY production caller is `diff-capture.ts:100` — the PR-diff path,
  which is deployment and PR-time only. A run that parks, fails or is retired locally never gets one.

### The two cost subsystems are DISJOINT by path

| path                                                                        | records to                      | state today                                          |
|-----------------------------------------------------------------------------|---------------------------------|------------------------------------------------------|
| the deployed gateway (`app/api/llm-gateway/route.ts` -> `gateway-recorder`) | `df_run_events.cost_usd`        | NULL on every run                                    |
| the in-process governed calls (the architect, and the reviewer)             | `df_usage_events.cost_usd`      | one real row, from #492                              |
| the worker cost client                                                      | the tenant's budget reservation | carries no `run_id`, so it cannot contribute per run |

Nothing writes both, which is what makes summing them safe. `df_cost_reservations` has no `run_id` at
all (`reservation_id, budget_id, estimated_usd, created_at, settled`), so the budget store is not a
source and cannot become one without a schema change.

### The shapes to copy

- A narrow single-column UPDATE already exists as a precedent: `updateCommentReference`
  (`run-history-postgres.ts:1417`, sqlite `run-history-store.ts:1649`). A `recordRunCost` is the same
  shape, and being an `UPDATE` it cannot clobber a concurrent status change the way a read-modify-write
  through `recordRunSummary` would.
- `PersistedRunEvent` is `{ sequence, event }` and `RunEvent` carries `costUsd?: number`
  (`run-history.ts:83`), so a run's recorded cost events are readable through the existing
  `listRunEvents` — no new reader.

## The definition this plan implements

A run's actual is the sum of what the run recorded:

    run cost = sum(usage events for run_id) + sum(run cost events for run_id)

The two are disjoint because each is written by a different execution path, and that the two never overlapping is
the invariant that makes the sum correct rather than double counting. It is stated in the ADR, and
#532 — which may start recording sandbox usage in the ledger — must revisit it if it does.

## Global constraints

- The definition is PURE and lives in one module. No store, no clock, no environment, so a test pins
  it exactly.
- A missing source contributes zero, never `NaN`. A negative or non-finite cost is ignored rather than
  summed: the failure that matters is a run looking cheaper than it was.
- The write is BEST-EFFORT. A cost is an observation about a run, not a control over it, so a failed
  write must never fail a run — unlike a run record, where fail-closed is right.
- The write is idempotent by recompute: the value is always the whole sum, so a re-write from a
  resumed run replaces rather than adds.
- No content: money only, never prompts or file contents.

## Review focus

- **The sum must not be satisfiable by one source alone.** Assert a run with usage AND events, so an
  implementation that silently drops one path fails rather than passing on a single-source fixture.
- **The two never overlapping is an assumption, not a check.** Prove the two sources are read from different places,
  and pin the invariant in the ADR with the cross-reference to #532 rather than pretending a test can
  detect a future overlap.
- **A failed write must leave the run alone.** Assert the run's status and other fields are untouched,
  so "best-effort" is proven rather than asserted.
- **Clamping, not throwing.** A negative or non-finite input yields the sum of the usable values.

## Tasks

### Task 1 — the pure definition

**Files:** create `agent/lib/dark-factory/run-actual-cost.ts`, test
`tests/dark-factory/run-actual-cost.test.ts`.

```ts
export interface RunCostSources {
  /** Summed from the usage ledger for this run. */
  usageCostUsd?: number;
  /** Summed from the run's own cost events (the gateway path). */
  eventCostUsd?: number;
}

export interface RunActualCost {
  costUsd: number;
  /** What went into it, so a reader can tell the two paths apart. */
  sources: { usageCostUsd: number; eventCostUsd: number };
}

export function sumRunActualCost(sources: RunCostSources): RunActualCost;
```

RED: both sources present sum; one present still sums (the other contributes zero); absent entirely
is 0 rather than undefined or NaN; a negative or non-finite value is ignored; the parts are reported
alongside the total; the same input gives a byte-identical result.

### Task 2 — the narrow store write

**Files:** modify `agent/lib/dark-factory/run-history-store.ts` (the interface),
`run-history-postgres.ts`, `run-history-store.ts` (sqlite), `run-history-provider.ts`,
`notifying-run-history.ts`; test `tests/dark-factory/record-run-cost.test.ts`.

```ts
/** Record a run's actual cost (#531). A narrow UPDATE: it cannot clobber a concurrent status change. */
recordRunCost(runId: string, costUsd: number | null): Promise<RunHistoryWriteResult<RunSummary>>;
```

RED: the write lands and is readable back; a re-write replaces rather than accumulates; a non-finite
value is refused with a reported failure rather than written; an unknown run reports a failure rather
than throwing; `null` clears it (the "not measured" state, distinct from `0`).

### Task 3 — the writer (composition)

**Files:** create `agent/lib/dark-factory/run-cost-recorder.ts`, test
`tests/dark-factory/run-cost-recorder.test.ts`.

Reads the run's usage through `queryUsage(store, { runId })`, reads the run's cost events through
`listRunEvents(runId)`, sums with Task 1's function, writes with Task 2's method. Returns a result
object rather than throwing, and logs-and-continues on every failure: a run must never fail because its
cost could not be recorded.

### Task 4 — the call site

**Files:** modify `scripts/dark-factory-runner.ts`; test
`tests/dark-factory/run-cost-wiring.test.ts` (source guard, the repo's convention for composition
roots — confirm the exact site inside the runner's end-of-life path and scope the guard so a sibling
call cannot satisfy it).

### Task 5 — ADR 0075 and docs

**Files:** create `docs/adr/0075-the-run-actual-is-summed-from-its-sources.md`, modify
`docs/adr/README.md` and `docs/pages/dark-factory-cost-estimation.md`.

Records: the definition and its two sources; the invariant that they never overlap and the explicit instruction
that #532 must revisit it; why the write is best-effort while a run record is fail-closed; and that
`df_plan_estimate_accuracy` becomes usable as a result. Link the new module from the cost page (the
doc-drift guard requires it).

---

## Validation

- Full suite green with no new failures, `tsc --noEmit --incremental false` clean, and every pinned
  linter clean locally on the changed files (cspell, markdownlint, table formatter, link check).
- **Live proof, the headline of this issue:** run the factory for real, then show
  `df_run_summaries.cost_usd` populated AND `df_plan_estimate_accuracy` returning its FIRST row — the
  view that has returned zero rows for the whole of this epic. Show the calibration report reading the
  same run, so the two definitions are visibly consistent.
- Unset the run-time `DF_*` exports before validating, or the suite lies.

## Settled decisions (agreed at GATE 1)

1. **The actual is usage plus cost events.** Each execution path records to exactly one place, so
   summing both covers a run without counting anything twice. The usage ledger alone would under-report
   every deployed sandbox run, and understating is the failure that matters.
2. **A narrow `recordRunCost`.** An `UPDATE` cannot clobber a concurrent status change, and it mirrors
   `updateCommentReference`; a read-modify-write through `recordRunSummary` could.
3. **Best-effort, always.** A cost is an observation about a run, not a control over it, so a failed
   write logs and continues rather than failing the run — deliberately unlike a run record, where
   fail-closed is right.
4. **The runner's end of life is the only call site in this change.** The retire and
   terminal-transition paths stay out, keeping the change reviewable and the live proof reachable.
5. **A resumed run grows its cost, and the last write wins.** The value is always the whole sum, never a
   per-attempt delta, so a re-write replaces rather than accumulates.

### Consequence worth naming

6. **When NEITHER source recorded anything, the writer writes nothing at all** — the run stays NULL
   rather than reading as `0`. This follows the epic's existing rule that a run with no estimate is
   excluded rather than counted as zero (ADR 0074, #490 AC4): "unmeasured" and "free" are different
   findings, and only one of them is ever true here. Flagged for visibility because it is a
   consequence of decisions 1 and 3 rather than a separate choice.

## Risks that remain

- **The sum depends on the two paths never overlapping.** No test can detect a future overlap, so the
  ADR states the invariant and #532 is instructed to revisit it if it starts recording sandbox usage in
  the ledger.
- **A run that records nothing on either path** writes no cost at all, so the view stays empty for it.
  That is the honest outcome, but it means the view's first row depends on a run whose architect or
  gateway calls were actually recorded.
