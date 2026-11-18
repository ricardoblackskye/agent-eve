# #673 — a blocked Definition of Done must still report its acceptance matrix

**Issue:** [#673](https://github.com/ricardoblackskye/agent-eve/issues/673) (child of #666)
**Branch:** `fix/dod-ac-matrix-on-blocked-673`, based on `origin/main` @ `9ea40e7` (the merge of #680)

## Goal

A run whose Definition of Done ends `blocked` should report the acceptance-criteria matrix it
already computed, instead of reporting `AC Matrix Count 0`.

## Root cause (verified in code, not inferred)

The matrix is computed for every run that has a mapped plan, and then dropped on exactly the
outcome that needs it.

**1. It is computed before the review loop** — `definition-of-done.ts`:

```ts
// 1b. Verify Acceptance Criteria if task has an ExecutionPlan
let acMatrix: AcTraceabilityItem[] | undefined;
let traceabilityTable: string | undefined;

if (task.plan?.acceptanceCriteriaMap && task.plan.acceptanceCriteriaMap.length > 0) {
  const verification = evaluateAcTraceability(task.plan, task.testResults ?? []);
  acMatrix = verification.matrix;
  traceabilityTable = renderAcTraceabilityTable(acMatrix);
  ...
```

**2. The success result carries both** — `buildSuccessResult(...)` takes
`acMatrix?: AcTraceabilityItem[]` and `traceabilityTable?: string` and includes them.

**3. The blocked result carries NEITHER** — `buildBudgetExhaustedResult` takes six parameters
and its type has no matrix or table field:

```ts
function buildBudgetExhaustedResult(
  pr: PullRequestDetails,
  maxRounds: number,
  roundsExecuted: number,
  totalDistinctFindings: number,
  acceptedCount: number,
  remaining: ReviewFinding[],
): DefinitionOfDoneResult {
  return {
    ok: false,
    status: "blocked",
    pr,
    roundsExecuted,
    totalFindings: totalDistinctFindings,
    resolvedCount: totalDistinctFindings - acceptedCount - remaining.length,
    acceptedCount,
    remainingFindings: remaining,
    reason: `Review budget exhausted (${maxRounds} rounds) with ${remaining.length} unresolved finding(s).`,
  };
}
```

**4. The call site has both values in scope and does not pass them** — inside
`if (round === maxRounds)`:

```ts
const blocked: DefinitionOfDoneResult = buildBudgetExhaustedResult(
  pr,
  maxRounds,
  roundsExecuted,
  totalDistinctFindings,
  acceptedIds.size,
  remaining,
);
```

`acMatrix` and `traceabilityTable` were declared earlier in the same function, so this is a
parameter pass, not a computation that has to be added.

**5. Downstream, both consumers read the missing field.** The runner prints
`line("AC Matrix Count", dodResult.acMatrix?.length ?? 0)` — hence the observed `0` — and the
success comment embeds `dodResult.traceabilityTable`, while the **blocked** comment
(`dark-factory-runner.ts`, "Story #N is NOT done") renders the status, the reason, the PR and
the outstanding findings and **no traceability at all**.

### Evidence from real runs

Every local run so far has ended `blocked`, and every one printed the symptom:

```text
DoD Status                       blocked
Is DONE (ok)                     false
AC Matrix Count                  0
```

The same runs' plans did map criteria — #230's plan reported `AC Mappings Count 5` — so the
plan was never the problem. This is the `blocked` path, and `blocked` is what all three runs hit.

### Why this is the worst possible place to lose it

The matrix is the traceability between what the story asked for and what the change does. The
blocked comment is the artefact a reader opens to understand *why* the run did not certify — and
it currently says what failed while never saying what the ticket wanted. #502 already established
the principle in this module that **an omission must not read as a clean result**; an empty matrix
on a mapped plan is the same class.

## Intended fix

1. **`buildBudgetExhaustedResult` takes and emits both fields**, mirroring `buildSuccessResult`,
   so the two result shapes agree on carrying the traceability the run computed.
2. **The call site passes `acMatrix` and `traceabilityTable`.**
3. **The blocked comment includes the table when present**, so the reader of a blocked run sees
   the same traceability a successful run shows. Decided here rather than deferred: the fields
   existing in the result but not being rendered would leave the original symptom half-fixed, and
   the comment is one template edit in the same function that already has the result to hand.

No ADR. This restores behaviour the module already intends (#502's principle, and the success
path's existing shape) rather than making a new decision — there is nothing a future reader would
have to ask "why" about that the code and this plan do not already say.

## Tasks (TDD — RED and GREEN as separate commits)

### Task 1 — RED: a mapped plan with an exhausted review budget still reports its matrix

`tests/dark-factory/definition-of-done-ac.test.ts` — the file that owns the AC cases, and which
has no case for this combination. Reuse the shape of
*"collects all error severity findings across dispositions before blocking"* (`:177`) to drive the
budget to exhaustion, with a plan whose `acceptanceCriteriaMap` is populated.

Assert **all** of:

- `status` is `"blocked"` (the control: the case must still be a blocked run, not accidentally a
  success — otherwise it would pass for the wrong reason today);
- `acMatrix` is present and has an entry per mapped AC;
- `traceabilityTable` is present and mentions the mapped AC ids.

Run: `npx vitest run tests/dark-factory/definition-of-done-ac.test.ts`
Expected: FAIL — `acMatrix` is currently `undefined` on this path.

### Task 2 — RED: the blocked comment renders the traceability

The comment is built by a pure function in `dark-factory-runner.ts`, so assert on its output for
a blocked result that carries a table: the rendered text must contain it. Same file style as the
runner's existing comment tests if one exists; otherwise the assertion is a direct call.

### Task 3 — GREEN: the parameter pass and the template

Apply sections 1-3. Run the AC suite, then the runner suite, then the full suite.

Commit convention: `test(673): RED — ...` then `fix(673): GREEN — ...`.

### Task 4 — confirm the print and the record

`line("AC Matrix Count", dodResult.acMatrix?.length ?? 0)` needs no change once the field is
populated; confirm from the test output rather than editing it. Check whether any other consumer
reads `acMatrix`/`traceabilityTable` off a `blocked` result and state what they do.

## Files likely to change

| File                                                                         | Change                                                           |
|------------------------------------------------------------------------------|------------------------------------------------------------------|
| `agent/lib/dark-factory/definition-of-done.ts`                               | the builder takes + emits both fields; the call site passes them |
| `scripts/dark-factory-runner.ts`                                             | the blocked comment renders the table when present               |
| `tests/dark-factory/definition-of-done-ac.test.ts`                           | Task 1                                                           |
| `tests/dark-factory/definition-of-done.test.ts` or the runner's comment test | Task 2, wherever the comment is best asserted                    |

## Validation

- `npx vitest run tests/dark-factory/definition-of-done-ac.test.ts tests/dark-factory/definition-of-done.test.ts`
- The **full** suite before the push: `npx vitest run --exclude 'tests/env-example-coverage.test.ts'`
  with CI's DB env vars set. A targeted run is not a gate — on #672 I pushed on targeted runs
  while the full suite was still going, and CI caught what they missed.
- `npx tsc --noEmit --incremental false`
- Local lint gate on every changed file: `npx -y cspell@9.1.1`, `npx -y markdownlint-cli@0.45.0`
  with a config **file**, the pinned `npx -y markdown-table-formatter@1.6.1 --check`. This plan
  file included: fenced blocks carry a language, headings carry no trailing punctuation, a single
  trailing newline, every `name@version` token inside backticks, and no line opening with a bare
  issue reference (which reads as a markdown heading).

## Risks and open questions

- **The result shape grows on one more path.** `DefinitionOfDoneResult.acMatrix` and
  `traceabilityTable` are already optional and already populated on success, so a consumer that
  handles the success shape handles this. Stated because a reader comparing the two builders
  should see that the fields were optional rather than newly introduced.
- **`AC Matrix Count 0` may be legitimate on some runs** — a plan that maps nothing. #502 added
  `missingMap` for exactly that, and the distinguishing signal is whether the plan had a map at
  all, not whether the count is zero. The RED asserts the mapped case so the fix cannot be
  satisfied by reporting an empty matrix for everything.
- **Not in scope:** the runner's `AC Matrix Count` print, the DoD's review budget itself (that is #676), and
  whether a blocked run should post the traceability to the PR as well as the issue.
  The issue is the ticket's record; the PR comment is a separate question.
- **After this lands, #224/#226/#230's evidence becomes the regression guard's story**: three real
  runs reported `0` while their plans mapped 4, 4 and 5 criteria.
