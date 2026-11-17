# Plan: keep inline HTML out of the generated plan's prose

Story: #666 (item 6, found by the WebFeedPOC#226 run)

## Goal

Stop the generated plan artifact from failing the target's `markdownlint` on `MD033/no-inline-html`, so a
run whose product change is good cannot be blocked by the wording of its own plan.

## Root cause (verified against a real run)

The WebFeedPOC#226 run produced a correct 4-line product change and a PR whose `MegaLinter` went red:

```text
.hermes/plans/df-226.md   MD033/no-inline-html   x12
```

The trigger is one sentence of the plan's own prose, where the model quoted the element instead of
describing it:

> …the ProductList/Pagination block: `<p><em>Built by the Dark Factory - by the Developer Agent</em></p>`.
> No props, state, routing, data-fetching or CSS changes are made…

Raw inline HTML in prose is what MD033 reports. The run's own lint gate could not see it, because
WebFeedPOC declares `lint` (eslint) and `typecheck` (tsc) - **markdownlint runs only in CI, through
MegaLinter**. Reproduced locally on the branch: `npm run lint` exit 0, `eslint --no-ignore` on the changed
JSX exit 0, `markdownlint` on the plan exit 1.

The #224 plan had no inline HTML, which is the entire reason PR #225 passed. The failure is
plan-text-dependent, not change-dependent, which is why it only surfaced on the second attempt.

## Why the fix belongs here, and not in a disable directive

`plan-file.ts` already states the principle this decision follows:

> The rules this renderer CAN satisfy - MD040, MD024, MD026 - are deliberately left on.

MD033 is satisfiable by the renderer, so it is satisfied rather than silenced. The alternative - adding
`MD033` to the plan's `markdownlint-disable` directive alongside MD013 - would work, but MD013 is disabled
precisely because it *cannot* be satisfied without corrupting generated content. Adding a satisfiable rule
to that list would widen the exemption and erode the distinction the file's comment exists to draw.

## The fix

A fence-aware pass in `renderPlanFile` that wraps raw HTML tags occurring in prose in backticks, so:

```text
the block: <p><em>Built by ...</em></p>. No props are changed.
```

renders as:

```text
the block: `<p><em>Built by ...</em></p>`. No props are changed.
```

`renderPlanFile` already contains both the precedent and the machinery: `withFenceLanguages()` runs a
fence-aware pass over the rendered lines (its own #659 fix for MD040), and the table-cell helpers show the
house style for a small deterministic transform with a comment explaining the risk it avoids.

Rules the pass must respect, each of which is a test:

- **Code fences are left completely alone.** MD033 ignores fenced blocks, and rewriting inside one would
  corrupt the content the fence exists to protect.
- **Existing inline code spans are left alone**, so a second pass cannot nest backticks.
- **Only tag-shaped text is wrapped.** A bare `<` used as a comparison must not be touched.
- **HTML comments are left alone** - the plan's own `<!-- markdownlint-disable ... -->` directives are
  comments, and MD033 does not report them.

The architect prompt is **not** changed. An instruction to a model is a preference, not a guarantee; the
deterministic pass is what makes the artifact safe, and adding prompt text would create the impression the
renderer is not doing the work.

## Tasks (TDD)

1. **RED** - a test in `tests/dark-factory/plan-file.test.ts` asserting that a plan whose prose contains
   `<p><em>x</em></p>` renders MD033-clean, plus the four controls above. It fails today.
2. **GREEN** - the fence-aware pass in `renderPlanFile`.
3. Re-run the focused suite, the full suite, `tsc --noEmit`, and cspell.

## Files likely to change

| Path                                                  | Change                                    |
|-------------------------------------------------------|-------------------------------------------|
| `agent/lib/dark-factory/plan-file.ts`                 | the fence-aware inline-HTML pass          |
| `tests/dark-factory/plan-file.test.ts`                | the RED/GREEN cases and the four controls |
| `.hermes/plans/2026-11-17_df-plan-inline-html-666.md` | this plan                                 |

## Validation

The unit tests prove the transform. The real proof is the artifact: **#226's plan JSON is preserved in
the issue's `dark-factory:plan-block` comment**, so the new renderer can be run over the exact plan that
failed and the result checked with the same command that failed:

```bash
npx -y markdownlint-cli@0.45.0 -c $TMP/markdownlint.json <rendered plan>   # expect exit 0
```

on a config with MD033 on, which is the state that produced the 12 findings.

**PR #227 is not fixed by this change.** Its plan file is already committed in WebFeedPOC, so that pull
request needs its own plan corrected or a re-run. Worth deciding which, now that #227 is otherwise the
better of the two footer PRs.

## Risks and open questions

- **Wrapping changes the model's text, so it must not change meaning.** Wrapping a tag in backticks is the smallest
  possible edit that satisfies the rule, and the four controls exist to bound it.
- **The `held`/`blocked` distinction and the other four #666 findings are out of scope here.** This plan
  covers only the MD033 gap. #666 remains open for items 1-5.
- **The general shape is worth noting**: a run is "lint clean" by its own gate while CI enforces more,
  because the target's declared checks are not the descriptor set CI runs. That is a broader question than
  this fix, and it belongs in #666 rather than here.

## No ADR

The renderer's own comment already states the principle being applied - satisfy the rules it can, disable
only those it cannot. This change follows that precedent rather than setting a new one.
