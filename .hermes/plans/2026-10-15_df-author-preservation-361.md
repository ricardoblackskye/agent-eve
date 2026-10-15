<!-- markdownlint-disable MD013 -->

# Dark Factory: the coding workflow must not overwrite working code

**Goal:** make the Dark Factory coding loop preserve existing code, commit the tests it authors, and
generate a real plan file — written with the superpowers planning methodology, committed, and posted
as a comment on the issue so a human can review the approach.

**Architecture:** make the author aware of the file it is changing, then verify preservation
deterministically at the loop boundary. Give the architect a plan structure that can express an
approach and a task breakdown, render that to markdown, and publish it in both places a reviewer looks:
the commit and the issue.

**Tech stack:** TypeScript, Vitest, the Dark Factory runner and the `agent/lib/dark-factory` modules.

## Root cause (read from the code, not inferred)

The first full end-to-end run (against issue #359) replaced the entire 75-line `Chat` component in
`app/chat.tsx` with a 15-line stub, deleted its `useEveAgent` wiring, message list, composer form and
auth headers, and still reported `DoD Status: done`.

1. **The author is asked for whole files and never sees the current one.** `buildCodeAuthorPrompt` in
   `agent/lib/dark-factory/code-author.ts` asks the model to "provide the code to write", with "values
   are string file contents", and the task it receives is `author.write({ plan })` — the plan alone. A
   `modify` target must therefore be regenerated blind.
2. **The only write primitive is a full-file overwrite.** `WorkspaceTools.writeFile(relPath, content)`
   in `agent/lib/dark-factory/developer-agent.ts` writes complete contents; there is no edit tool and no
   read-before-write, so replacing a file in one call is legal by design.
3. **Nothing compares the result against what was there.** The Definition of Done validates a
   type-check plus the authored tests, and `app/chat.tsx` had no coverage, so
   type-correct-but-destructive code is reported as done.
4. **The authored test is never committed.** The runner stages
   `executionPlan.targetFiles.map((f) => f.path)`, so a file the loop wrote that the plan did not
   predict — here `app/chat.test.tsx` — is dropped from the commit.
5. **The plan is never written down.** The architect's `ExecutionPlan` is printed and discarded, so the
   pull request carries a diff with no stated intent.

## The Factory does not currently use superpowers (verified)

The repo has `docs/superpowers/plans/` holding **only two plan files** — plans written *for* building
the Dark Factory, not the skill text, which is not copied into the repo anywhere. The architect's own
prompt asks for a flat JSON object (`storyId`, `title`, `summary`, `targetFiles`,
`acceptanceCriteriaMap`, `dependencies`) and ends "Return ONLY raw JSON. No conversational text or
markdown code fences." So its `summary` is a change list rather than an approach, and no planning
methodology is applied.

## Decisions agreed before planning

| Question                         | Decision                                                                             |
|----------------------------------|--------------------------------------------------------------------------------------|
| A destructive `modify`           | REFUSE past half the original lines; fail the iteration so the loop retries informed |
| Genuine rewrites                 | A plan may declare a replacement; only then may a large deletion proceed             |
| Scope                            | The three defects in issue #361 are one workflow gap                                 |
| `create` when the file exists    | Check existence; if it is there, IGNORE the create rather than overwrite             |
| What the plan file contains      | The approach, not just a file list                                                   |
| How the Factory uses superpowers | Copy the skill text into the repo and use it in the architect prompt                 |
| Reviewability                    | Post the plan file as a comment on the issue, BEFORE the coding loop                 |
| Plan authorisation               | Add a release that parks the run for human approval before coding starts             |

## Proposed approach

**Author with awareness.** `CodeAuthorTask` gains the current contents of each `modify` target, and the
prompt carries a preservation contract: return the complete updated file, preserve every existing
export, import, prop, handler and markup element the plan does not ask you to change, and do not delete
code you were not asked to change.

**Verify preservation deterministically.** A new module `preservation-guard.ts` gives
`assessPreservation(before, after)` returning the removed line count, the removed ratio and a verdict.
The worker consults it per `modify` target; over the threshold the iteration FAILS with a message naming
the file, both counts and the escape hatch, so the next iteration retries informed.

**Make replacement explicit.** `PlanTargetFile.action` gains `"replace"`, accepted by the validator. A
large deletion is permitted only for `replace`. For `create`, the workspace is checked first: an
existing file makes the action a no-op, recorded as a plan-versus-reality mismatch.

**Stage what the loop actually wrote.** Stage the union of predicted and authored paths, and warn when
the two disagree, so an authored test reaches the commit.

**Generate a real plan.** Copy the superpowers planning skill text into the repo
(`agent/lib/dark-factory/planning-guidance/writing-plans.md`) with its source, license and a sync note,
load it through a small module, and use it in the architect prompt. Extend `ExecutionPlan` with
`approach` and `tasks` so the plan can state how the change will be made, then render it to
`.hermes/plans/<date>_<slug>.md`, commit it, reference it from the pull request body, and post it as an
issue comment before the coding loop starts.

## Release split

The change has grown past a single reviewable unit. Suggested split, with a branch named per release:

| Release                    | Branch                           | Delivers                                                                             | Issue |
|----------------------------|----------------------------------|--------------------------------------------------------------------------------------|-------|
| R1 Preserve                | `fix/df-author-preservation-361` | Awareness, preservation guard, `replace` action, `create` existence check            | #361  |
| R2 Commit what ran         | `feat/df-run-artifacts-361`      | Stage authored files; render and commit the plan file                                | #361  |
| R3 Plan quality and review | `feat/df-plan-methodology-361`   | Superpowers skill in the architect, `approach` and `tasks`, plan as an issue comment | #361  |
| R4 Plan approval gate      | `feat/df-plan-approval-361`      | Park the run after planning; resume on the human's approval, then code               | #361  |

**Recommendation:** deliver R1 and R2 together on this branch — they are the same code path, and R1 is
the safety fix that should land first — and take R3 and R4 on their own branches, because R3 changes the
architect schema and prompt and R4 changes control flow; bundling either would hold the safety fix
behind it.

## The plan approval gate (R4)

Asked whether the issue side lets a human authorise the plan before coding starts: **it does not, and no
run ever pauses for a human today.** The evidence, read from the code:

- `worker-reporter.ts` can render a "blocked on a human decision" comment and record `status: blocked`,
  but it never applies the `needs-answer` label, and **the runner never calls it** — its only callers are
  `scripts/worker-reporter-demo.local.ts` and tests.
- The RESUME half is real and tested: `trigger.ts` resumes a blocked run when a human comments or clears
  `needs-answer` (#306), and `entry.ts` refuses a resume with no blocked run to resume.
- The park step was planned in #162 and #164 and described precisely there — the wiring never landed.

So the gate wires two existing halves together and inserts the park between planning and coding: once
the architect has planned and the plan comment is posted, apply `needs-answer`, mark the dispatch
`blocked`, and stop. The human's comment, or clearing the label, resumes the run at the coding phase.

**R4 depends on R3**, because a resumed run must know what was approved — the plan has to be durable
before the run parks, which is R3's committed plan artifact and run record. R4 gets its own plan and
branch; this document records only the design and the dependency. Its proof is the gate both ways:
coding does not start before approval, and does start after it.

## Tasks (TDD, one behavior per cycle)

### Task 1: preservation guard

**Files:** create `agent/lib/dark-factory/preservation-guard.ts`, test
`tests/dark-factory/preservation-guard.test.ts`.

A pure function over two strings, no I/O. Cover: identical content is fine; an additive change is fine;
75 lines reduced to 15 is refused; `replace` is exempt; an empty original is fine; and the EXACT
boundary either side of the threshold.

### Task 2: the prompt carries the file being changed

**Files:** modify `agent/lib/dark-factory/code-author.ts`, test `tests/dark-factory/code-author.test.ts`.

Assert the contract text AND that the existing content appears — a prompt asserted only as "not empty"
would pass while the file stayed invisible.

### Task 3: the worker consults the guard

**Files:** modify `scripts/dark-factory-runner.ts`, test `tests/dark-factory/runner-authoring.test.ts`.

Read each `modify` target before authoring, feed it to the author, assess the result. A refusal is a
failed iteration naming the file, both counts and the `replace` escape hatch.

### Task 4: `create` on an existing path is ignored

**Files:** modify `scripts/dark-factory-runner.ts`, test `tests/dark-factory/runner-authoring.test.ts`.

Existence check before the write; skip it and record the mismatch in the run record.

### Task 5: the `replace` action

**Files:** modify `agent/lib/dark-factory/plan-validator.ts`, test `tests/dark-factory/plan-validator.test.ts`.

Accept `"replace"` and keep rejecting anything else.

### Task 6: stage what the loop wrote

**Files:** modify `scripts/dark-factory-runner.ts`, test `tests/dark-factory/runner-authoring.test.ts`.

Stage the union of predicted and authored paths; warn when they differ.

### Task 7: copy in the superpowers skill and use it

**Files:** create `agent/lib/dark-factory/planning-guidance/writing-plans.md` and
`agent/lib/dark-factory/planning-guidance.ts`, modify `agent/lib/dark-factory/architect-agent.ts`, test
`tests/dark-factory/planning-guidance.test.ts`.

The copied file carries its source URL, the upstream commit or tag, the MIT license note and the sync
instruction. A test asserts the guidance reaches the architect prompt, so "we use the skill" is provable
rather than assumed.

### Task 8: the plan can express an approach

**Files:** modify `agent/lib/dark-factory/plan-validator.ts` and `architect-agent.ts`, test
`tests/dark-factory/plan-validator.test.ts`.

Add `approach` and `tasks` (title, objective, files, steps, verification) to `ExecutionPlan` and ask the
architect for them. The existing repair loop handles a model that omits them.

### Task 9: render the plan file

**Files:** create `agent/lib/dark-factory/plan-file.ts`, test `tests/dark-factory/plan-file.test.ts`.

Render the goal, approach, tasks with their steps and verification, files, and risks. The markdown must
be lint-clean: every fenced block needs a language (MD040), no duplicate headings (MD024), no heading
ending in punctuation (MD026). MegaLinter lints changed markdown in the pull request, so this is a
constraint on the renderer rather than a detail.

### Task 10: commit the plan and reference it

**Files:** modify `scripts/dark-factory-runner.ts`, test `tests/dark-factory/runner-authoring.test.ts`.

Write the rendered plan into the workspace, add it to the commit, and link it from the pull request body.

### Task 11: post the plan on the issue

**Files:** modify `agent/lib/dark-factory/issue-writer.ts` or the runner, test the same.

Post the plan as a comment as early as possible — right after planning, before the coding loop — so it
is reviewable even if the run later fails. Check for an existing plan comment first, so a retry does not
duplicate it.

## Files likely to change

| File                                                        | Change                                                         |
|-------------------------------------------------------------|----------------------------------------------------------------|
| `agent/lib/dark-factory/preservation-guard.ts`              | New: `assessPreservation`                                      |
| `agent/lib/dark-factory/planning-guidance.ts`               | New: load and expose the copied skill text                     |
| `agent/lib/dark-factory/planning-guidance/writing-plans.md` | New: the copied superpowers skill, with its source and license |
| `agent/lib/dark-factory/plan-file.ts`                       | New: render an `ExecutionPlan` to markdown                     |
| `agent/lib/dark-factory/code-author.ts`                     | Prompt carries current contents and the contract               |
| `agent/lib/dark-factory/architect-agent.ts`                 | Ask for `approach` and `tasks`; use the methodology            |
| `agent/lib/dark-factory/plan-validator.ts`                  | `replace` action, `approach` and `tasks`                       |
| `agent/lib/dark-factory/developer-agent.ts`                 | Worker-side guard seam if the tool surface needs it            |
| `agent/lib/dark-factory/issue-writer.ts`                    | Post the plan comment                                          |
| `scripts/dark-factory-runner.ts`                            | Read targets, stage authored files, write and commit the plan  |
| `tests/dark-factory/*`                                      | New and extended suites                                        |
| `docs/pages/dark-factory-modules.md`                        | Catalog rows for the new modules                               |
| `docs/adr/NNNN-*.md`                                        | The decision records below                                     |

## Validation

- Every new behavior has a test, watched fail then pass; the full suite shows no new regressions.
- `npx tsc --noEmit --incremental false` clean and `DF_PLATFORM_PROVIDER=generic npm run build` exit 0.
- **A local reproduction of the original failure:** a fixture workspace holding a 75-line file, an
  additive plan targeting it, and an author stub returning the 15-line stub. Assert the guard FAILS the
  iteration with the actionable message, and that the same stub with a `replace` plan PASSES. This is
  the test that would have caught the real run.
- Lint locally on the changed files, including the generated plan markdown.
- Optional and only on your say-so: a live run against a throwaway issue. It spends model credit, pushes
  a branch and opens a pull request.

## Risks and open questions

- **The threshold is settled: past half the original non-blank lines of a `modify` target is refused.**
  Changes of that size need justification, which is what the `replace` declaration provides. Test the
  exact boundary either side.
- **A line-count guard cannot see intent.** A legitimate large refactor inside one file trips it, which
  is what `replace` exists for. The failure message should say so.
- **Copying the skill text in creates a sync burden.** Record the upstream commit in the copied file so a
  future reader can diff it, and keep the copy verbatim so that diff stays meaningful.
- **A larger plan schema can fail validation more often.** `approach` and `tasks` add surface for the
  model to omit; the repair loop covers it, but the first live run should be watched.
- **Comment ordering is settled:** the plan comment posts before the coding loop, so a failed run still
  leaves a reviewable plan.

## Architecture decision records to write with this change

1. The authoring path carries the current file contents, and the loop verifies preservation.
2. A whole-file replacement requires an explicit plan declaration; it is never inferred.
3. A `create` action never overwrites an existing file.
4. The run generates and publishes its own plan artifact, and the Factory writes plans with the
   superpowers methodology.
