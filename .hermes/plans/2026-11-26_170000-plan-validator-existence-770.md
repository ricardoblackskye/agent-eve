# Make the plan validator's existence rule actually run, and refuse a `create` on an existing file (#770)

**Issue:** [agent-eve#770](https://github.com/ricardoblackskye/agent-eve/issues/770) (`bug`)
**Branch:** `fix/770-plan-validator-existence` (off `origin/main` @ `8284e2d`)
**Status:** plan for GATE 1 — no code written yet.

**Goal:** make `-> Domain Validation Passed!` mean what it sounds like. Two defects, and fixing either alone
changes nothing, so they go in one change.

---

## Context

Reproduced three times in one afternoon. `WebFeedPOC#269` and `#271` both planned `create src/App.test.jsx` for a
file that already exists with **340 lines**, and both runs printed `Domain Validation Passed!`. On `#271` I also
posted plan feedback saying so, verified as the newest comment before the resume — and **the action did not
change**: PR #272 modified `src/App.jsx` by one line and never touched the spec. So the conversational path does
not prevent this; only a validator does.

### Defect 1 — the `create` branch is exempt from the check

`agent/lib/dark-factory/plan-validator.ts:295-312` (#381 R2 Task 8) does compare targets to the repository:

```ts
// A `create` target is DEFINED as a file that does not exist yet, so its absence is not an error.
// Only `modify` and `replace` target an existing file and therefore require presence (#454).
if (file.action === "create") continue;
if (!context.files.includes(targetPath)) { … }
```

The `create` branch **skips the check entirely**, so the one case that has actually gone wrong — a plan claiming
`create` for a file that is present — is the one case never compared against reality. The rule validates the plan
against itself.

### Defect 2 — no file list ever reaches the rule on the runner path

```text
scripts/dark-factory-runner.ts:1143   validateExecutionPlan(executionPlan, issueData.body);   <- no context
scripts/dark-factory-runner.ts:1086   validateExecutionPlan(amended.plan, issueData.body);   <- no context
```

and rule 1b is guarded by `if (Array.isArray(context?.files))`. With no context, `context.files` is `undefined`,
so **the rule never executes** — neither the `create` half nor the working `modify`/`replace` half. The only
caller that supplies a list is the architect's own path (`architect-agent.ts:1113`), conditionally.

## Approach

**A. Fix the polarity.** For a `create` target, existence IS the error: refuse it with a code
(`target-exists`), telling the plan author to restate the action as `modify`. `modify`/`replace` keep their
current rule (absence is the error, code `target-missing`).

**B. Supply the file list at both runner call sites.** The seam already exists and is already wired — the runner
constructs the architect with `listFiles: planReader.listFiles` (`runner:841`), and the architect obtains its list
with `this.deps.listFiles(".")` (`architect-agent.ts:1041`). So the fix reuses that, adding no dependency:

```ts
validateExecutionPlan(plan, issueData.body, { files: await planReader.listFiles(".") })
```

**Confirm during implementation, do not assume:** that `planReader` is in scope at BOTH call sites (1143 and
1086). They are in different branches of the resume/revision logic, and wiring one and missing the other is the
recurring shape in this codebase.

**C. Pin the join.** Add a wiring assertion that the runner passes a file list to the validator. A rule whose parts
are each tested and which nothing calls is precisely how this defect came to be — the rule was ADDED believing it
worked.

## Tasks

### Task 1 — RED: a `create` target that exists is refused

**Files:** `tests/dark-factory/plan-validator-target-missing.test.ts` (the existing home of rule 1b's tests)
**Files:** `agent/lib/dark-factory/plan-validator.ts`

- A plan with `{ path: "src/App.jsx", action: "create" }` against a `files` list that CONTAINS `src/App.jsx` is
  refused, and the result carries the `target-exists` code.
- **Control 1:** a `create` target that is genuinely ABSENT is still accepted — without this the fix would block
  every legitimate new file, which is worse than the defect.
- **Control 2:** a `modify` target that is absent is still refused with `target-missing` (the existing behaviour,
  now reachable from the runner too).

Run: `npx vitest run tests/dark-factory/plan-validator-target-missing.test.ts`
Expected RED: the first case fails today because the `create` branch `continue`s before the check.

### Task 2 — GREEN: the validator change

Invert the `create` branch: presence is the error, absence is expected. Keep the message actionable (name the file,
say the action should be `modify` when it exists), because a refusal that only says "invalid" makes the repair
round re-guess.

### Task 3 — RED/GREEN: the runner supplies the list

- Assert the runner's validation calls pass `files`, **bounded to each call site** — an unbounded grep in a
  2,800-line file has passed here while the wiring was absent.
- Assert the list is non-empty in the assertion's own fixture, so the check cannot pass vacuously.
- Then wire BOTH call sites.

### Task 4 — the live shape

Take the plan that actually failed — `#271`'s `targetFiles` (`modify src/App.jsx`, `create src/App.test.jsx`) — and
assert that against WebFeedPOC's real file list it is now REFUSED. That is the defect stated as a test rather than
described, and it is the check that would have stopped all three occurrences.

## Files likely to change

- `agent/lib/dark-factory/plan-validator.ts` — rule 1b's `create` branch.
- `scripts/dark-factory-runner.ts` — both validation call sites, and the `planReader` scope confirmation.
- `tests/dark-factory/plan-validator-target-missing.test.ts` — the validator cases.
- A runner-side wiring test (existing file if one fits; otherwise beside the other `runner-*` tests).

## Verification

- RED and GREEN committed separately, each with its controls.
- `tsc --noEmit` exit 0; the full suite in the gate's mode with the six `DF_*_TEST_DATABASE_URL` set; the coverage
  ratchet.
- **A refusal must be observable end to end**: a plan in the failed shape produces
  `Plan domain validation rejected:` with the new code, rather than `Domain Validation Passed!`.

## Risks

- **Existing fixtures may depend on the skip.** Any test that builds a plan with a `create` target present in its
  file list will now be refused — that is the rule working, but each such fixture needs reviewing rather than
  bulk-updating: a fixture is either a plan that was always invalid (good, it now fails) or a legitimate new file
  whose `files` list is stale (fix the fixture).
- **The architect path supplies `files` conditionally** (`context.gated && context.sawEvidence`). Leaving that as
  it is means the refusal fires on the runner path but not always in the architect's; the two should be aligned in
  one change or the inconsistency recorded.
- **A `create` on a path that exists in a DIFFERENT case or with a trailing space** would pass this check while
  still colliding on disk. Out of scope here, but worth stating so the rule's limits are known.

## Out of scope

- **#763's other legs** — R2 (bind the run to the approved set), R3 (declare substitutions), R4 (measure re-plan
  variance). R1 is implemented here.
- **#764** — the AC matrix certifying criteria whose tests were never written. This change prevents the *cause* in
  this path; it does not make the certification honest when a test is missing for another reason.
