# Plan — Architect repair must keep the target repository's identity (#451)

**Issue:** #451 · **Date:** 2026-10-24 · **Epic:** Dark Factory web UI
**Status:** PROPOSED — awaiting GATE 1 approval (no code on this branch yet)

## Context (root cause, traced)

While proving #405 against `ricardoblackskye/WebFeedPOC#172`, the Architect's
plan attempts drifted to `agent-eve` itself after the first rejection: attempt 2
targeted `architect-agent.ts` with `ARCHITECT_AGENT_TIMEOUT_MS`, which the story
("create a new sub-heading on the main page") never mentioned.

The repair prompt is built by `buildRepairPrompt` in
`agent/lib/dark-factory/architect-agent.ts` (lines 656–675). It forwards only:

- `Story #${story.number}` — the number alone,
- the `validation.errors` list,
- the previous raw output.

It does **not** receive what `buildInitialPrompt` (580–648) and `amendPlan`
(which reuses `buildInitialPrompt`) do inject:

- the story `title`/`body` narrative,
- the discovered repository file list (`repoFiles` from `deps.listFiles(".")`),
- the discovery evidence section and the mechanically-checked target contract.

So the initial attempt is grounded in the target repository; every retry is not.
The model, with no repository context on a rejected plan, fills the gap from its
own association with "Architect Agent" and invents a plan for `agent-eve`.

Three open questions from the issue are now answered by reading the code:

- **Q1 — does the repair prompt carry the target identity?** No. Confirmed by
  inspection of `buildRepairPrompt` and its two call sites (895, 937), which pass
  only `(story, previousOutput, validation)`.
- **Q3 — is agent-eve source contaminating the prompt (vs invented)?** Invented.
  Nothing in the repair prompt references agent-eve; the discovered reads were
  proven rooted at the target (validation received WebFeedPOC's 254 files). The
  wrong-repo plan is a hallucination from thin context, not a leak.
- **Q2 — should a repair proposing a file outside the discovered set be refused,
  not retried?** The validator already emits `target-missing` for a `modify`/
  `replace` of a path not in `context.files` (plan-validator.ts 221–236), but
  `runPlanLoop` only folds `target-role` into the `refusedTarget` flag (line 780);
  `target-missing` is retried as `plan-invalid`.

`StoryInput` carries only `number`/`title`/`body` — no owner/repo. The target's
identity *is* the discovered file list plus the evidence, so grounding the repair
prompt in those is sufficient; no new input field is required.

## Decision

Two slices, matching the issue's intended direction.

### Slice A — ground the repair prompt (primary)

Extend `buildRepairPrompt` to also receive a grounding object and emit a grounding
block that mirrors the initial prompt's, so every retry is anchored to the same
repository:

```ts
private buildRepairPrompt(
  story: StoryInput,
  previousOutput: string,
  validation: PlanValidationResult,
  grounding: { repoFiles: string[]; evidenceSection?: string; targetContract?: string },
): string
```

The returned prompt restates, before the errors:

- the target identity in the same `<user_story>` XML containment the initial prompt
  uses — `<story_id>`, `<story_title>`, `<story_body>` (via `escapeXmlContent`),
- `### REPOSITORY STRUCTURE:` — the `repoFiles` list, capped to `maxContextFiles`
  via `sortFilesByRelevance` (identical to the initial prompt's sizing),
- `### REPOSITORY EVIDENCE:` and `### TARGET CONTRACT …` when present,
- an explicit directive: *"This repair must target the SAME repository listed
  above. Do not plan against any other repository and do not introduce files
  outside the ones shown."*

Then the existing `### VALIDATION ERRORS:` + `### PREVIOUS OUTPUT:` + fix
instructions follow, unchanged in intent.

Both call sites pass the grounding:
- `planStory` (895): the closure already has `repoFiles`, `context.section`,
  `targetContract` in scope — pass them.
- `amendPlan` (937): the closure has `repoFiles` and `input.story`; pass
  `repoFiles` (evidence/contract are absent on that path, which is already the
  case today — no behaviour change there beyond grounding).

Budget note: the initial prompt already fits this grounding within
`promptBudget()` (400k chars), and the repair prompt is proportional to it, so
re-including the structure list does not break the over-budget refusal.

### Slice B — classify a wrong-repository repair as refused-target

In `runPlanLoop`, also set `refusedTarget = true` when a validation code is
`target-missing` **and** the validator was given a file list (`context?.files`),
so exhaustion reports `refused-target` instead of `plan-invalid`:

```ts
if (codes.includes("target-role") || (codes.includes("target-missing") && Array.isArray(context?.files))) {
  refusedTarget = true;
}
```

This stops the loop spending more retries on a plan that left the target repo.
Limitation: a `create` action for a path outside the discovered set is exempt from
`target-missing` by design (a create is *meant* to be a new file), so Slice B does
not catch a `create` of a wrong-repo path. That case is mitigated primarily by
Slice A (grounding the prompt); extending the existence rule to `create` paths is
out of scope here and would need its own issue.

## Tests (RED then GREEN, with non-vacuity)

Add to `tests/dark-factory/architect-agent.test.ts` (or a sibling
`architect-agent-repair.test.ts` if the file grows unwieldy):

- **RED A — grounding reaches the retry.** Drive `planStory` with a fake `deps`
  whose `listFiles` returns a synthetic repository (`["web/page.tsx", "web/api.ts"]`
  plus a marker file unique to the target). The fake `generate` returns an invalid
  plan first, so the second call's prompt is the repair prompt. Assert the captured
  repair prompt contains the marker file, the story title, and the "same repository"
  directive. (Captured by intercepting the `generate` call's prompt argument.)
- **RED B — wrong-repo modify is refused, not plan-invalid.** Drive `planStory`
  so the rejected plan targets a `modify` of a file NOT in `repoFiles`. Assert the
  result `reason` is `"refused-target"` (not `"plan-invalid"`).
- **GREEN** implements Slice A and Slice B; both RED tests pass.
- **Non-vacuity:** (1) revert `buildRepairPrompt` to drop the grounding block →
  RED A fails; (2) remove the `target-missing` join in `runPlanLoop` → RED B fails.
  Restore both → green.

## Gates (all before the PR)

`cspell@9.1.1` (`.cspell.json`), markdownlint (MD040/MD026/MD047), markdown-table-formatter,
`npm run test`, `npx tsc --noEmit --incremental false`,
`DF_PLATFORM_PROVIDER=generic npm run build`, and the doc-drift / adr-integrity
guards.

## Files touched

- `agent/lib/dark-factory/architect-agent.ts` — `buildRepairPrompt` signature +
  grounding block; `runPlanLoop` `refusedTarget` join; both repair closures (895, 937).
- `tests/dark-factory/architect-agent.test.ts` — RED/GREEN cases.
- `docs/adr/0059-*.md` — record the grounding contract for the repair loop and the
  `refused-target` vs `plan-invalid` classification (to be numbered at commit).
- `docs/adr/README.md` — index entry.

## Out of scope (explicit)

- The discovery reader, the validator's existence rule for `create`, other agents.
- Owner/repo plumbing into `StoryInput`: the discovered file list is the target's
  identity already; no new field is needed.

## Why this is the minimal correct fix

**#405** fixed the discovery **read**; **#451** is the repair **loop**. Both must carry
the target identity, or a plan about the wrong repository survives by a different
route. Raising the retry count would only spend more tokens on a plan that already
left the target — so the fix is to keep the target load-bearing on every attempt,
not to try harder.
