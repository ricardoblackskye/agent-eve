# The run details page shows what the run actually recorded

**Goal:** a run's detail page shows every value the run has - Started, Elapsed, Attempts, Review round, Measured cost, the agent output, the acceptance criteria - and shows an honest dash, never an inferred zero, for anything it does not have.

**Architecture:** two seams move. The summary's timestamps are derived from the run's own events, so existing rows are fixed with no backfill. And the panel titled "AGENT TRACE" stops showing the acceptance-criteria matrix and starts showing captured agent output, whose cap is decoupled from the worker's 2000-character question protocol.

**Tech stack:** TypeScript, Next.js client components, Vitest, the Postgres run ledger.

**Issue:** [#698](https://github.com/ricardoblackskye/agent-eve/issues/698)

**Branch:** `fix/run-details-completeness-698`

## Root cause (measured on a real production run)

Run `e626dc1e-e4f4-4967-af44-484254e04777` (WebFeedPOC#200) reported **succeeded** and rendered this:

Its own ticket tells the opposite story, which is the whole point of this issue. WebFeedPOC#200's comments show
the run doing exactly what the factory promises:

```text
16:16:08  Dispatched Hardened Pipeline on #200
16:16:28  machine-readable plan posted            -> parked, awaiting approval
17:05:11  "I approve"                             <- the human reply
17:05:59  Dispatched again (the resume)
17:10:18  Story #200 Completed with Verified Traceability - PR #201 + the AC matrix
```

That issue now carries `df:done` and is closed. **The run worked. The page lost the record of it** - which is
what "most of these are not being updated in Prod" means.

| field                   | shown                               | what the data says                                                     |
|-------------------------|-------------------------------------|------------------------------------------------------------------------|
| Started                 | `—`                                 | the run's own events start at 16:16:03                                 |
| Elapsed                 | `—`                                 | its events span 16:16:03 to 17:10:14                                   |
| Attempts                | `0`                                 | a worker demonstrably ran                                              |
| Review round            | `0`                                 | never reviewed, so arguably true but indistinguishable from unmeasured |
| Measured cost           | `$0.00`                             | a recorded zero, not a measurement                                     |
| Iterations / Fix cycles | `0` / `0`                           | recorded zeros                                                         |
| Agent trace             | "No agent trace reference captured" | the panel holds the AC matrix, not a trace                             |

So the root cause is not the factory's behavior. It is that **a run's summary row is written early and never
receives its terminal facts** - the start and finish times, the PR URL, the diff, the counters - so the page
renders a hollow version of a successful run.

Four causes, each verified in code:

1. **`started_at` and `completed_at` are NULL while the events carry both.** The writer only sets a start time when the active-run record already had one - `scripts/dark-factory-runner.ts:2057`: `...(active.startedAt === undefined ? {} : { startedAt: active.startedAt })`. The reader is honest (`row.started_at !== null ? { startedAt: row.started_at } : {}`), which is why a dash appears rather than a wrong time.
2. **The counters are `NOT NULL DEFAULT 0`** and `toDetailView` renders them unconditionally (`String(summary.iterationCount)`), so a counter that was never measured is displayed as a measurement - while that panel keeps the badge "NO INFERRED ZEROS".
3. **`trace` IS the acceptance-criteria matrix.** Its only writer is the Definition of Done (`definition-of-done.ts:748`, `:782` - `trace: acMatrix`), and `TracePanel` renders `{acId, description, testCaseName, testFile, passed}` under badges `["AC", "REASONING"]`. No reasoning is recorded anywhere: `reasoning` appears in this repository only as an LLM **parameter** (thinking level), never as captured text.
4. **The agent output that does exist is in a different panel.** `AgentOutputPanel` renders `event.agentOutputSummary` (#558), which is why the run's plan question is visible on the page while the trace panel says nothing was captured.

`format.ts` already documents the right posture: *"An absent measurement renders as an em dash, never a zero."* The formatters are honest; the values reaching them are not.

## Decisions taken with the user (2026-11-19)

Investigating the trace option **B** (fetch the run's Eve trace into the page) showed it is **blocked**, on four counts:

- Eve exposes no app-facing trace API. Its surfaces are OpenTelemetry export to a backend, and Workflow run tags readable in the Vercel Workflow dashboard.
- There is **no `agent/instrumentation.ts`**, so nothing is configured to export to.
- Content recording is **off by default** (`recordInputs`/`recordOutputs` default to `false`), with the docs requiring a retention review before enabling it - so even an exporter would not carry reasoning.
- The local `.eve/.workflow-data/` is the workflow engine's internal event log (`specVersion: 6`), not a usable trace source.

Agreed instead: **do 1 and 2** - surface the captured agent output as the trace view, and widen that capture so it reads as what each agent actually did - and **revisit a true reasoning trace separately**, since it needs either a superseded ADR 0082 or an exporter plus a retention decision.

## Intended fix

- **A. Derive Started and Elapsed from the run's own events** when the summary lacks them, in `toDetailView`. First event gives the start, last gives the end. This repairs existing rows, including production ones, with no backfill.
- **B. Record `started_at` and `completed_at` on the handoff (label) path**, so new runs do not depend on the derivation.
- **C. Stop rendering unmeasured values as zeros.** The counters and cost need to distinguish "measured zero" from "not measured" - the ledger's `NOT NULL DEFAULT 0` is the reason they cannot today, so this is a read-side fix plus, where it can be recorded, a write-side one.
- **D. Panel consolidation.** The acceptance-criteria matrix gets its own panel, correctly titled; the agent trace panel shows the captured agent output instead.
- **E. Widen the captured agent output** by decoupling the cap from `MAX_QUESTION_CHARS` (2000) - a bound for the worker's *question protocol*, not for capture - and record the larger cap in a new ADR within ADR 0082's "summary, not transcript" posture. `PreparedAgentOutput.truncated` already exists, so a partial capture can say so.

## Tasks

### Task 1 - RED: timestamps derive from the events

**Files:** `app/dark-factory/ui/view-model.ts` (test first)

Fixture: the shape of `e626dc1e` exactly - a summary with no `startedAt`/`completedAt` and three events, 16:16:03 to 17:10:14.

```ts
it("derives Started and Elapsed from the events when the summary has neither", () => {
  const view = toDetailView({ summary, events });
  expect(view.summaryTiles.find((t) => t.key === "started")?.value).not.toBe("—");
  expect(view.summaryTiles.find((t) => t.key === "elapsed")?.value).toBe("53m 11s");
});
it("CONTROL: still prefers the summary's own timestamps when present", () => { /* ... */ });
it("CONTROL: still shows a dash when there are no events at all", () => { /* ... */ });
```

**Expected RED:** the first assertion fails with the dash. Both controls pass, or the fixture is wrong.

### Task 2 - GREEN: the derivation

### Task 3 - RED/GREEN: an unmeasured value renders as a dash, not a zero

A summary whose counters were never measured must not render `0` under a "NO INFERRED ZEROS" badge, and a genuinely measured `0` must still render `0` - both cases, or the change trades one lie for another.

### Task 4 - RED/GREEN: the panels tell the truth

The acceptance matrix moves to its own panel (titled for what it is); the trace panel renders captured agent output; a run with no captured output still says so honestly.

### Task 5 - RED/GREEN: widen the capture

Decouple the cap, keep redaction and the `truncated` flag, and prove a longer output survives the round trip while a secret in it is still redacted.

### Task 6 - ADR for the widened cap, plus the gates

## Files likely to change

| file                                     | change                                                                           |
|------------------------------------------|----------------------------------------------------------------------------------|
| `app/dark-factory/ui/view-model.ts`      | derive timestamps; rename `trace` to its real meaning; add the agent-output view |
| `app/dark-factory/ui/components.tsx`     | retitle and separate the two panels                                              |
| `app/dark-factory/runs/[runId]/page.tsx` | mount the corrected panels                                                       |
| `agent/lib/dark-factory/agent-output.ts` | decouple the capture cap from `MAX_QUESTION_CHARS`                               |
| `scripts/dark-factory-runner.ts`         | record `started_at`/`completed_at` on this path                                  |
| `docs/adr/NNNN-...md`                    | the widened capture cap                                                          |

## Validation

- The RED fixture is a real production run's shape, so the fix is provable on this machine without production access.
- Unit tests per leg, then the full suite, `tsc --noEmit --incremental false`, and the repo's lint gates on every changed file.
- **Proof on the user's machine:** the details page for a run whose summary has no timestamps must show a real Started and Elapsed, and its trace panel must show the captured output rather than a dash.

## Risks and open questions

1. **Release split.** This is four work streams in one change. They could ship as two: (a) the data honesty fixes (A, B, C) and (b) the presentation and capture fixes (D, E). Say the word and I will split the branches.
2. **The widened cap needs its own ADR** - it stays inside ADR 0082's posture (a bounded, redacted summary, never a transcript), but a future reader will ask why the bound is what it is.
3. **This was first mistaken for a separate lifecycle bug, and that reading is withdrawn.** The run's page said "No PR opened yet" on a run that reached "Definition of Done met", which suggested the DoD had certified work that never happened. The ticket's own timeline disproves it - **PR #201 exists** and the issue is closed as `df:done` - so the defect is the incomplete summary described above, and no separate issue is needed.
