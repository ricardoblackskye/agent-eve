# 549 - the drift issue's repair step names a file that does not exist

## Goal

Fix the operator instruction the Price Drift workflow posts, and add the guard the issue asks for so the same
line cannot rot again. Text-only plus a test: no runtime behaviour changes.

## Verified findings

| Where | State |
| `.github/workflows/price-drift.yml:70` | the repair step says `--write` "refreshes agent/lib/dark-factory/model-price-floor.json" - that file does not exist |
| every mention of the stale name in the tree | exactly ONE (line 70). Nothing else in code, docs or tests carries it |
| open drift issues in the wild | none. The only open issue mentioning the path is this one, so there is no posted instruction to correct |
| the module that does exist | `agent/lib/dark-factory/model-price-floor-data.ts`, written via `PRICE_FLOOR_DATA_RELATIVE_PATH` (from ADR 0071) |
| the other paths the workflow names | `cost-budget.ts` and `tests/model-price-ceiling.test.ts` both exist, so line 70 is the only wrong one |
| the docs page added by #499 | already names the `.ts` module correctly, so it needs no change |

Why it rotted: ADR 0070 put the observation at a JSON path, ADR 0071 moved it into `agent/` as a generated TS
module (the Eve build rejects a bare `.json` inside `agent/lib/`), and this one line was left behind.

## The guard

The issue asks for a test because the failure is silent. Direction matters: the artefact made a claim the TREE
does not satisfy, so the guard runs artefact -> tree - extract every path-like mention from the workflow and
require each to resolve to a real file.

- Scope to `price-drift.yml` ALONE. Measured, not assumed: a directory-wide version would fail on `ci.yml`,
  which names seven `.eve/e2e-*.sqlite` files that resolve to nothing by exact path or by suffix in the tracked
  tree - they are SQLite databases that job creates at runtime, not repository files.
- Extract from the whole file rather than only the `BODY` heredoc, so the explanatory comment at the top is
  covered too (it names `tests/model-price-ceiling.test.ts`).
- Anchor non-vacuity: assert the extracted set is non-empty in the same test, or it passes over nothing.
- Add a control: a fabricated path run through the same extractor must NOT resolve, so a broken regex cannot look
  like a pass.
- Require the extension to sit on a boundary. My first pass over `ci.yml` reported `eve/e2e-usage.sql`, which is
  only the prefix of `.eve/e2e-usage.sqlite`; an extractor without a boundary would report a path nobody wrote.
- Prove it is live: after GREEN, put the stale name back and confirm the guard goes red again.

## Also prove the posted text locally

The repair step builds its body in a shell heredoc, so a quoting slip would break the step at runtime and the
guard above would not see it. Extract that step from the YAML, `bash -n` it, then run it with a `gh` shim on PATH
that captures argv and the body it would post - asserting the body names `model-price-floor-data.ts` and no longer
names the `.json`.

## Global constraints

- Do not rename the job: the branch ruleset gates on the check name "Unit Tests" and this job must never be it.
- Do not touch the schedule, the trigger, or the concurrency block.
- The replacement text lands inside a double-quoted shell string, so it must not introduce `$`, backticks or
  quotes.
- The repair instruction must keep naming the ceiling file and the refresh command - both are correct today.

## Tasks

1. Correct line 70 to the generated module, keeping the sentence readable.
2. Add the guard to `tests/doc-drift-guards.test.ts` (the established home for `guard:` tests): RED on the current
   state for the right reason, then GREEN.
3. Re-break the path and confirm the guard fails - a guard never seen red is not evidence.
4. Run the extracted repair step under a `gh` shim and assert the body it would post.
5. Re-run the guard tests LAST, after every file is in place.

## Validation

- The guard tests, plus the full DSN-enabled suite (expect the single known `env-example-coverage` artefact).
- cspell and markdownlint over the changed `.yml` and `.ts` files.

## Review focus

- The guard proves a named path EXISTS; it cannot tell whether the surrounding sentence is the right instruction.
  A confident wrong sentence naming a real file still passes, and that limit is worth knowing when reading it.
- The extraction pattern is deliberately narrow (a code or doc extension). A mention without an extension is not
  checked, so this is a floor, not a proof of prose correctness.
- No behaviour changes: the ceiling file, the command, the schedule and the job name are all untouched.
