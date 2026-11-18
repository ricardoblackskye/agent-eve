# A check that has not finished is not a failure — implementation plan

**Goal:** give the Definition of Done a way to say "the checks have not finished yet" that is distinct
from "the checks failed", so a run is not reported as a failure while its own evidence is still arriving.

**Issue:** ricardoblackskye/agent-eve 691 (surfaced by the WebFeedPOC#232 end-to-end run).

**Architecture:** the distinction already exists in the finding id and nothing consumes it. The fix
makes the run's OUTCOME read it, and gives the deferral the park's retry-free shape rather than
inventing a scheduler that does not exist.

**Tech stack:** TypeScript, Vitest, GitHub Actions, Postgres.

---

## Root cause (verified in code, not inferred)

`checkRunFindings` (`agent/lib/dark-factory/definition-of-done.ts:120-159`) produces two findings that
differ only in their id:

```ts
if (check.status !== "completed") {
  findings.push({ id: `PR-CHECK-UNSETTLED:${check.name}`, source: "linter", severity: "error",
                  message: `... has not finished (${check.status}) ... cannot be certified done against it.` });
  continue;
}
if (PASSING_CONCLUSIONS.has(check.conclusion ?? "")) continue;
findings.push({ id: `PR-CHECK-FAILED:${check.name}`, source: "linter", severity: "error",
                message: `... failed (${check.conclusion ?? "no conclusion"}) ...` });
```

Both are `severity: "error"`, and **nothing downstream reads either id**:

```text
grep -rn "PR-CHECK-UNSETTLED|PR-CHECK-FAILED" --include=*.ts agent/ scripts/ tests/
  -> definition-of-done.ts (the producer) and one comment in pr-checks-timeout.ts
```

The vocabulary confirms it: `export type DoneStatus = "done" | "blocked" | "refused"`
(`definition-of-done.ts:243`) - there is no value for "not finished".

Observed on the WebFeedPOC#232 run, which ended with both findings present and one verdict:

```text
PR-CHECK-UNSETTLED:e2e (error): The check 'e2e' has not finished (in_progress), so this run
                                cannot be certified done against it.
PR-CHECK-FAILED:MegaLinter (error): The repository's own check 'MegaLinter' failed (failure)
  DoD Status   blocked
```

An `e2e` suite that was still running at the twenty-minute cap is indistinguishable, in the outcome,
from a check that ran and said no. The `e2e` one may yet pass; the run's record says otherwise.

### What is NOT wrong

**The certification refusal is correct and this plan does not touch it.** ADR 0087 and 659 Stage 3
exist precisely so a run cannot claim done against an outcome it cannot see. The defect is the
**outcome** the refusal produces, not the refusal. Every task below keeps a control that still refuses
`done` while a check is unsettled.

## The constraint that shapes the fix

There is no queue, worker or scheduler - the deployed executor and remote sandbox are parked in 668,
and runs are kicked off manually until the flows are proven. The deployed path runs the loop inline
inside a request, so **an inline wait cannot outlast the platform's function cap**: waiting longer is
not an available lever. A deferral therefore has to be a **re-entry**, not a longer wait.

## Intended fix

1. **Read the distinction the producer already makes.** Make the run's outcome derive from whether the
   blocking finding is `PR-CHECK-UNSETTLED:*` or `PR-CHECK-FAILED:*`, instead of treating every
   blocking finding as one thing.
2. **A distinct, non-terminal outcome for "not finished".** The ticket must be able to say "the checks
   have not settled, re-check" rather than "this failed". The ticket stays re-triggerable, so a
   re-check after the checks settle is the existing re-trigger operation rather than a new mechanism.
   Reuse the shape of `ParkedRunError` (`dispatch.ts:43`, handled at `:461`): a distinct outcome that
   consumes no retries and no backoff, which is exactly what #162 uses for a run waiting on something
   other than itself.
3. **A failed check stays a failure**, and stays terminal, exactly as today.
4. **Keep the DoD status vocabulary honest.** `DoneStatus` and the label vocabulary owned by
   `trigger.ts` move together, as #672 established: the labels are derived from the status, so a new
   status is a labelling decision as well as an outcome one.

## Settled decisions

**D1 - the refusal is not weakened.** Only the outcome changes; the blocked/refused certification path
keeps its behavior, and the RED carries a control asserting a run still cannot report `done` against
an unsettled check.

**D2 - the deferral is a re-entry, not a longer wait.** Justified by the absence of any scheduler and
by the inline execution under the platform cap. A longer `testTimeout`-style answer (ADR 0089) is a
different mechanism for a different problem and does not help here.

**D3 - reuse the park shape rather than add a scheduler.** A park already means "this is not a
failure, do not burn retries" - the semantics needed. Inventing a polling worker would be 668's
parked work by another name.

**D4 - one ADR.** A fourth outcome value is exactly the kind of thing a future reader asks "why is
this not just blocked?" about. Short, in the same change.

## Tasks

### Task 1 - RED: the outcome must distinguish an unfinished check from a failed one

**Files:** `tests/dark-factory/definition-of-done-checks.test.ts` (new; extend
`definition-of-done-ac.test.ts` instead if the assertion reads better there)

```ts
it("reports checks-pending, not blocked, when the only obstacle is a check that has not finished", () => {
  const result = runDod({ checks: [{ name: "e2e", status: "in_progress", conclusion: null }] });
  expect(result.status).toBe("checks-pending");
});

it("CONTROL: still refuses `done` while a check is unsettled", () => {
  // 659 Stage 3 must survive this change: the run may not claim done against an outcome it cannot see.
  const result = runDod({ checks: [{ name: "e2e", status: "in_progress", conclusion: null }] });
  expect(result.status).not.toBe("done");
});

it("CONTROL: a FAILED check still reports blocked, not checks-pending", () => {
  // Without this the two cases could collapse in the other direction.
  const result = runDod({ checks: [{ name: "MegaLinter", status: "completed", conclusion: "failure" }] });
  expect(result.status).toBe("blocked");
});
```

**Verify RED:** the first case fails (both cases report `blocked` today) and **both controls pass** -
read the tally, and count what passes, not only what fails.

```bash
npx vitest run tests/dark-factory/definition-of-done-checks.test.ts
```

### Task 2 - GREEN: derive the outcome from the finding kind

Whichever path produces `"blocked"` for check findings must ask whether the blocking finding is
unsettled. Keep the derivation narrow: a run with BOTH kinds present is a failure, not a deferral -
the failed check is real evidence and must not be laundered into "wait".

### Task 3 - the ticket comment and the label vocabulary

The comment says what is true: the checks have not finished, here they are with links, re-check after
they settle. The label must not read as a failure (the vocabulary lives in `trigger.ts`, per #672).

### Task 4 - prove the re-entry

A local run: end a run in the new outcome, then re-trigger it once the checks have settled, and show
it proceeds. This is a measurement against the real stack, in the same spirit as 689 and 690 - the
claim is "the ticket is re-checkable", which no unit test can establish.

### Task 5 - the ADR and its index row

`docs/adr/0090-an-unfinished-check-is-not-a-failure.md`, plus a one-line index row (compute the
padding; an over-wide row re-pads the whole table).

### Task 6 - the six gates

Suite, `tsc`, cspell, markdownlint, pinned table formatter, link check, coverage ratchet - with the
`darkfactory_test` variables 689 introduced.

## Files likely to change

| File                                                                           | Change                                                         |
|--------------------------------------------------------------------------------|----------------------------------------------------------------|
| `agent/lib/dark-factory/definition-of-done.ts`                                 | the outcome derivation reads UNSETTLED vs FAILED               |
| `agent/lib/dark-factory/trigger.ts`                                            | the label vocabulary, if a label is added                      |
| `agent/lib/dark-factory/run-finalizer.ts`                                      | only if the terminal/non-terminal mapping needs the new status |
| `tests/dark-factory/definition-of-done-checks.test.ts`                         | RED, with both controls                                        |
| `docs/adr/0090-an-unfinished-check-is-not-a-failure.md` + `docs/adr/README.md` | the decision and its index row                                 |
| `.hermes/plans/2026-11-18_dod-checks-pending-691.md`                           | this plan                                                      |

## Risks and open questions

**Risks.**

- **Weakening the certification.** The single largest risk: a change that makes "unsettled" look
  acceptable would undo 659 Stage 3. Guarded by a control in the RED that asserts `done` is still
  refused.
- **Laundering a real failure into a delay.** A run with both findings must report the failure. The
  second control pins it.
- **The deployed path may not reach this code at all today** (668): the answer must say what is proven
  locally and what is not.

**Open questions for the reviewer.**

1. **The repo-level case.** On #232 the failing check was a repo-wide advisory the change provably did
   not cause (the branch's `package-lock.json` is identical to main's). Options: compare the failing
   check against the default branch, an operator-declared list of repo-level checks, or leave it out.
   This plan recommends **leaving it out of this change** and filing it separately.
2. **A fourth `DoneStatus`, or a machine-readable reason on `blocked`?** A status is visible to every
   consumer; a reason string is not. This plan assumes the status.
3. **Should the deferral be automatic?** With no scheduler the honest answer is a documented
   re-trigger. If you want automatic, that is a scheduling decision, and 668 is where it lives.

## Out of scope

- The deployed executor, the platform cap and any queue or scheduler (668).
- Feeding a genuinely failed check back into the developer loop - a larger change whose first
  ingredient is deciding the repo-level question above.
- 690's timeout sizing and 689's database split, both landed.
