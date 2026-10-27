# #501 — a cosmetic log line must not abort a Dark Factory run

- **Branch:** `fix/local-run-501` (off `origin/main` @ `4b15cd3`)
- **Issue:** #501
- **Related:** #502 — the rule that a plan with no acceptance-criteria mappings is **refused**. Deliberately
  not implemented here, per the decisions taken at GATE 1.
- **Date:** 2026-10-27
- **Discovered by:** the real local run against `ricardoblackskye/WebFeedPOC#173` that was intended to
  close #487's AC6

## Goal

Make a local Dark Factory run survive a plan that omits `acceptanceCriteriaMap`, so that progress output
can never kill a run; and fix the two launcher defects that made the first three attempts fail with an
error that named the wrong thing.

This is also what unblocks #487 AC6: with the crash gone, the same run reaches the park, and the plan row
plus its estimate are written before it does.

**Scope boundary.** #501 is a robustness fix and changes nothing about what a plan may contain. After it,
a plan with no acceptance-criteria mappings still runs and still validates, exactly as today. Refusing that
plan is #502's job.

## Root cause (verified, not inferred)

### 1. The crash is a logging line dereferencing a missing field

`scripts/dark-factory-runner.ts`:

```ts
560|  let executionPlan = planResult.plan;
561|  console.log("\n  -> Architect Planning Succeeded!");
562|  line("Plan Summary", executionPlan.summary);
563|  line("Target Files", executionPlan.targetFiles.map((f) => f.path).join(", "));
564|  line("AC Mappings Count", executionPlan.acceptanceCriteriaMap.length);
```

Evidence from the run log: the last lines printed are `Plan Summary` and `Target Files`, the string
`AC Mappings Count` never appears, and the process ends with

```text
[ERROR] Runner aborted: Cannot read properties of undefined (reading 'length')
```

The log stops exactly between lines 563 and 564, and 564 is the only `.length` dereference in that
window. There is no stack trace because the top-level handler prints only the message.

### 2. Why the field is missing: a later self-correction attempt replaced a good plan

The architect is constructed with `maxPlanRetries: 2` (`dark-factory-runner.ts:470`) — one initial attempt
plus two self-correction cycles. The run made **three** attempts, each streamed to the log:

| Attempt | Log lines | `acceptanceCriteriaMap`     | `targetFiles` vocabulary |
|---------|-----------|-----------------------------|--------------------------|
| 1       | 22-55     | absent                      | —                        |
| 2       | 56-92     | **present** (AC1, AC2, AC3) | `rationale`              |
| 3       | 92-304    | **absent**                  | `reason` plus `changes`  |

`planStory` returns the **last** attempt, which is the plan bound to `planResult.plan` at line 560. So
this is not "the model forgot the field once": a self-correction cycle replaced a plan that carried the
field with one that does not, and nothing objected.

Attempt 2 was rejected and attempt 3 accepted, which pins where the tolerance lives. Everything on the
path treats the field as optional except the log line:

| Location                     | Behaviour when absent                                        |
|------------------------------|--------------------------------------------------------------|
| `plan-validator.ts:53`       | declares `acceptanceCriteriaMap` non-optional                |
| `plan-validator.ts:351`      | validates only `if (plan.acceptanceCriteriaMap)` — tolerated |
| `definition-of-done.ts:175`  | `plan.acceptanceCriteriaMap ?? []` — degrades silently       |
| `dark-factory-runner.ts:564` | unguarded dereference — **aborts the run**                   |

That the underlying tolerance is the real defect is filed as **#502**; this change fixes only the abort.

### 3. `spawn git ENOENT` was a missing directory, not a missing git

`scripts/dark-factory-local-run.ts:33` defaults the workspace root to `join(process.cwd(), "df-workspaces")`
and `local-run.ts:136` clones with `cwd: dirname(plan.path)` — that root itself. When it does not exist the
git spawn fails, and Node reports `ENOENT` for a missing **cwd** as well as a missing executable:

```text
spawnSync('git', ['--version'], { encoding: 'utf8' })                       -> ok
spawnSync('git', ['--version'], { cwd: 'C:/not-a-real-dir', encoding: … })  -> ENOENT
```

The message names `git`, so the first three attempts were spent on PATH hypotheses that were all wrong.
The directory is never created and the error never names it.

### 4. The default workspace root dirties the repository

`git check-ignore` does not match `df-workspaces`, so the first successful clone leaves the cloned target
as an untracked directory inside the agent-eve working tree.

## Intended fix

The principle: **display never asserts on plan shape.** `validateExecutionPlan` is the only thing entitled
to refuse a plan, and a run is aborted by that validator — never by its own progress output.

1. Render the plan summary through a small pure helper that reports an absent field as absent instead of
   dereferencing it, and is callable from a test without driving a whole run.
2. Ensure the launcher creates its workspace root, or fails naming that directory rather than surfacing
   `spawn git ENOENT`.
3. Stop the default workspace root from dirtying the repository.
4. Comment the renderer with why it is defensive and where the completeness rule lives (#502), so the next
   reader does not "simplify" it back into a crash.

## Tasks

### Task 1 — the summary renderer tolerates a missing field

- **RED:** new `tests/dark-factory/runner-plan-summary.test.ts` importing the summary helper. Cases:
  a plan with three mappings reports `3`; a plan with **no** `acceptanceCriteriaMap` reports its absence
  and does not throw; `undefined` and `null` behave identically to absent. The RED commit carries the
  helper's signature with a `throw new Error("not implemented")` body (the surgery pattern), so the file
  collects and fails for the right reason rather than failing to resolve an import.
- **GREEN:** extract the block into an exported helper beside `line` and call it at 561-564.
- The extraction is not cosmetic: the current code cannot be asserted on without executing an entire run,
  which is exactly why a logging bug reached production.

### Task 2 — the launcher creates its workspace root

- **RED:** in `tests/dark-factory/local-run.test.ts`, a launch whose workspace root does not exist must
  either create it or fail naming that directory — never surface a bare `spawn git ENOENT`.
- **GREEN:** ensure the root exists before the clone.
- Note the existing seam: the clone is already injectable (`gitClone`), so the case is cheap to drive.

### Task 3 — the workspace root must not dirty the repository

- Add the default root to `.gitignore`.
- Consider a guard test, so the ignore rule cannot be dropped unnoticed.

### Task 4 — documentation and the reason in the source

- Document `DF_WORKSPACE_ROOT`, its default and the new failure mode on the page that owns local runs.
- Record in the renderer's comment that the completeness rule is enforced by #502, so a future reader knows
  the defensive access is deliberate rather than redundant.

## Files likely to change

| File                                             | Change                                                        |
|--------------------------------------------------|---------------------------------------------------------------|
| `scripts/dark-factory-runner.ts`                 | extract and export the summary renderer; call it; comment why |
| `tests/dark-factory/runner-plan-summary.test.ts` | new — the renderer's contract                                 |
| `agent/lib/dark-factory/local-run.ts`            | ensure the workspace root exists before cloning               |
| `tests/dark-factory/local-run.test.ts`           | the missing-root case                                         |
| `.gitignore`                                     | ignore the default workspace root                             |
| `docs/pages/*.md`                                | local-run documentation                                       |

## Validation

Local gates, all of which must be green before any push:

```bash
npx tsc -p tsconfig.json --noEmit --incremental false
npx vitest run
npx -y cspell@9.1.1 --no-progress -c .cspell.json <changed files>
npx -y markdownlint-cli@0.45.0 -c <cfg.json> <changed .md>     # MD040, MD026, MD047
npx -y markdown-table-formatter@1.6.1 <changed .md>
npx eve build
```

Then the end-to-end proof, which is the point of the exercise:

```bash
# local Postgres already running as df-local-pg
node --import tsx scripts/dark-factory-local-run.ts --repo ricardoblackskye/WebFeedPOC --issue 173
```

Expected: the run renders the plan summary including the absent-mappings line, passes validation, posts
the plan comment, persists the plan row **and** its estimate, and parks for approval. Reading the ledger
back proves #487's AC6 — the criterion this crash blocked.

## Decisions taken at GATE 1

| Question                                                         | Decision                                                                                                     |
|------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------|
| Should a plan with no acceptance-criteria mappings be accepted?  | **No.** Filed as its own issue, #502. #501 does not change what is accepted.                                 |
| Display before or after validation?                              | **Keep the summary before.** No reordering, so an operator still sees the plan the run is about to validate. |
| Ignore the workspace root, or default it outside the repository? | **Ignore it.** The smaller change wins, and a local run keeps writing where it does today.                   |

## Risks

- **The defensive renderer could mask a real regression.** If the field goes missing for a *new* reason, a
  harmless `none supplied` line is quieter than a crash. Accepted deliberately: a run must not die on its
  own output, and #502 turns the omission into a validation failure instead of a silent nothing. Until #502
  lands, a mapping-less plan is reported and then accepted.
- **An ADR was proposed and withdrawn.** The `fail-closed vs fail-open` decision that warranted one now
  lives in #502, where the policy is actually made. #501 records its reasoning in the code comment and here.

## Not in scope

- **#502** — refusing a plan with no acceptance-criteria mappings. Independent: #501 stands on its own even
  if #502 is deferred, and #502 is not even expressible until a run can survive long enough to validate.
- **Opening the PR (GATE 6)** — waits for explicit authorization. Re-running against `WebFeedPOC#173` is
  part of this change's validation, but the run is a local exercise: it posts a plan comment and parks, and
  it merges nothing.
