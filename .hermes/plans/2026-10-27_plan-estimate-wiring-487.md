# Wire the plan estimate into the architect flow — implementation plan for #487

> **For the implementer:** read "The flow as it actually is" before designing anything. The issue's
> assumed ordering is close but not what the runner does, and one detail breaks AC5 if missed.

**Goal:** a real plan gets a real cost band, persisted against its `runId` and plan revision, so the
band exists before anything human-facing advertises it.

**Architecture:** `estimatePlanCost` (#485) is pure and synchronous; the ledger (#486) is
`PlanLedger` on `RunHistoryStore`. This change is **wiring only** — no new estimator maths and no new
persistence. The work is choosing the right point in the runner, deciding the ordering against the
plan comment, and keeping the estimate best-effort so it can never fail a run.

**Tech stack:** TypeScript, Vitest, the existing runner. No new dependency.

---

## The flow as it actually is (verified in `scripts/dark-factory-runner.ts`)

The issue assumes `validate → estimate → persist → post comment`. What the runner does is:

| Line | What happens                                                                                 |
|------|----------------------------------------------------------------------------------------------|
| 249  | `const runHistory = withNotifications(createRunHistoryStore(env), env)`                      |
| 471  | *"A resume uses the approved plan; only a fresh run asks the architect"*                     |
| 482  | `architectAgent.planStory(...)` — fresh runs only                                            |
| 487  | `await checkpoint()`                                                                         |
| 661  | `revisionRound = counted.count + 1` — inside the revision-feedback branch                    |
| 669  | `recordPlanRevision(...)` — records the revision ROUND as a `run.resumed` event              |
| 684  | `validateExecutionPlan(executionPlan, issueData.body)` → **fails closed** (terminal + throw) |
| 698  | STEP 5 — prepares the coding loop (author, breaker, sandbox)                                 |
| 786  | `postPlanComment(issueWriter, {..., plan: executionPlan})`                                   |
| 807  | `parksForHumanApproval({ resuming: isResume, revision: isRevision })` → **parks**            |

Two consequences the issue could not have anticipated:

1. **The comment is posted in the SAME pass that then parks**, so "post the comment" is not the last
   step — the park is. The estimate's window is between validation (696) and the comment (786).
2. **A resume re-executes this same linear path.** On `--resume` the plan is read back from the
   comment, validation runs again, and execution reaches the same insertion point. So a naive
   insertion recomputes and re-persists the estimate on every resume, which is precisely what AC5
   forbids. The guard must be explicit: the plan is NEW only when `!isResume || isRevision`.

`RunHistoryStore extends PlanLedger` (#486), so `runHistory` already carries `recordPlan` and
`recordPlanEstimate` — no store wiring is needed, only the calls.

## The ordering question, which is the real decision

`PersistedPlan.commentRef` is optional, and `PlanRecordInput = Omit<PersistedPlan, "planId">`. The
ledger is **write-once with no upsert**, deliberately. So wherever `recordPlan` is called, whatever
`commentRef` it omits stays omitted forever.

That pits AC2 against the ledger's own contract:

- **AC2 says** persist the estimate **before** the comment. The reason is real: #488 must render the
  band *in* the comment, so the band has to exist first.
- **But persisting before the comment** means the plan row cannot carry `commentRef`, so the ledger
  loses the pointer to the plan's human-readable text — the field exists precisely to make that
  traceable.

Three ways out, and this is the decision I want settled at GATE 1:

|                       | Order                                              | Cost                                                                              |
|-----------------------|----------------------------------------------------|-----------------------------------------------------------------------------------|
| **A**                 | persist (no `commentRef`) → estimate → comment     | obeys AC2 literally; `comment_ref` stays null forever                             |
| **B** *(recommended)* | comment → persist (with `commentRef`) → estimate   | complete record and simplest; **deviates from AC2's wording**                     |
| **C**                 | persist → estimate → comment → attach `commentRef` | obeys AC2 and completes the record; needs a new ledger write, against "no upsert" |

**I recommend B**, on the grounds that persistence is best-effort (AC3), so persisting first protects
nothing — a failure to persist does not stop the comment going out either way. B therefore buys the
same durability while keeping `comment_ref` meaningful and adding no ledger surface. But it *does*
contradict AC2 as written, so I am not choosing it unilaterally.

## How each acceptance criterion is met

- **From the validated plan.** `validation` at 684 governs `executionPlan`; the estimate is computed
  from that same object, so the band describes the plan the run will actually execute.
- **Ordering explicit in code.** Whichever option is chosen, it gets a numbered comment matching the
  `[STEP n]` convention already in the runner, plus a test asserting the order rather than the result.
- **A failing estimate never fails the run.** `PlanLedger` methods return plain promises and can
  **throw**; so the call is wrapped best-effort with a logged warning, mirroring `recordSafely` in
  `usage-store.ts` and the telemetry discipline in `worker-usage.ts`. Note the deliberate contrast
  with `readPlanRevisionCount`, which **fails closed** — a cap must not be bypassed by an unreadable
  ledger. An estimate is an observation, not a control, so failing a run over it would be wrong. The
  plan states that distinction so a later reader does not "fix" it into fail-closed.
- **Integration test.** Drive the runner's plan phase with a fake history store and assert the stored
  row for a run that planned successfully.
- **Resume unaffected.** Guard on `!isResume || isRevision`; the write-once ledger rejects a duplicate
  revision as a second line of defence, and because persistence is best-effort that rejection is
  logged rather than fatal. A test asserts a plain resume writes nothing.
- **One real run.** Run the factory against a real issue and show the estimate reaching storage.

## Tasks (TDD)

### Task 1 — the estimate recorder

**Files:** create `agent/lib/dark-factory/plan-estimate-recorder.ts`, create
`tests/dark-factory/plan-estimate-recorder.test.ts`.

A thin best-effort wrapper beside `plan-revision-recorder.ts`: compute from a validated plan, map
`PlanCostEstimate` onto `PlanEstimateRecordInput`, call `recordPlanEstimate`, and return a result
object — never throw. RED first: assert it returns `{ok: false, error}` when the store throws, and
`{ok: true, estimate}` on success.

### Task 2 — persist the plan row and the estimate in the runner

**Files:** modify `scripts/dark-factory-runner.ts`.

Insert at the chosen point, guarded by `!isResume || isRevision`, using the runner's existing revision
number so the plan row and the estimate agree on `planRevision`. `source` is `"amendment"` on a
revision, `"architect"` otherwise.

### Task 3 — ordering and resume assertions

**Files:** create `tests/dark-factory/plan-estimate-wiring.test.ts`.

Assert the order (the comment is not posted before the estimate is persisted, per the chosen option),
that a plain resume persists nothing, that a revision persists a NEW revision rather than overwriting,
and that a throwing ledger leaves the run proceeding.

### Task 4 — docs and the real run

**Files:** modify `docs/pages/flow-cost-governance.md`, plus the PR body.

Document the ordering decision as implemented, and record the one real run that put an estimate in
storage.

## Files likely to change

```text
create  agent/lib/dark-factory/plan-estimate-recorder.ts
create  tests/dark-factory/plan-estimate-recorder.test.ts
create  tests/dark-factory/plan-estimate-wiring.test.ts
modify  scripts/dark-factory-runner.ts          the insertion + guard
modify  docs/pages/flow-cost-governance.md
modify  docs/pages/dark-factory-modules.md      new module needs a catalogue row or CI fails
```

## Validation

```bash
export PATH="/c/Program Files/nodejs:$PATH"
npx vitest run tests/dark-factory/plan-estimate-recorder.test.ts tests/dark-factory/plan-estimate-wiring.test.ts
npx vitest run
npx tsc -p tsconfig.json --noEmit --incremental false
npx eve build
npx -y cspell@9.1.1 --no-progress -c .cspell.json <changed files>
npx -y markdown-table-formatter@1.6.1 docs/adr/README.md
```

A new `agent/lib/dark-factory/*.ts` module fails the doc-drift guard unless a `docs/pages/*.md` page
references it, so the catalogue row ships with the module. `docs/` may also need the ADR 0069
reference updated if the ordering decision changes what the ADR describes.

## ADRs

**None new.** This change wires existing decisions rather than making one — the estimator's shape is
ADR 0069, the ledger's write-once posture is #486's. If the ordering decision departs from AC2 (option
B or C), that departure belongs in the PR body and a line in `flow-cost-governance.md`, not a new ADR.

## Risks and open questions

1. **The ordering decision above.** Recommendation B; needs your call because B contradicts AC2.
2. **Calibration history.** `estimatePlanCost` accepts `history?: RunSummary[]` for the revision
   factor. This plan passes nothing, so every band is a cold start marked low confidence. Reading
   prior runs is #490's job, and pulling it forward would widen this change into the calibration work.
   Confirm that is the right boundary.
3. **`planRevision` for a fresh run.** The runner tracks `revisionRound` inside the revision branch;
   the fresh value must be confirmed by reading the surrounding scope during Task 2 rather than
   assumed, and the row must use the same number the revision logic counts.
4. **Postgres is unexercised locally.** The estimate write is only truly executed against Postgres in
   CI, as with #486.
5. **No prose is persisted.** The estimator emits numeric and structural features only; the plan text
   stays in the comment. Any temptation to store the rendered plan here should be refused.

## Out of scope

Rendering the band in the comment (#488), the ADR (#489), the calibration report (#490), and per-stage
usage attribution (#492).
