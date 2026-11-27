# Declare the target choice, so an approver is deciding rather than inferring (#780, R3)

**Issue:** [agent-eve#780](https://github.com/ricardoblackskye/agent-eve/issues/780) (`enhancement`) - R3 of #763
**Branch:** `feat/763-r3-substitution-declaration` (from `origin/main` @ `d81a0d7`, 0 behind)
**Status:** plan only. No code until GATE 1.

## Why we are doing this

The Dark Factory's plan decides which files a run will change, working from a story written in plain words. When it
picks a different file from the one the story names, nothing says so. The choice appears in the plan's table and the
reason sits in the architect's log, but the plan never states the action it is taking - so the person approving it is
left to infer whether the choice was deliberate.

That is not theoretical. On the same unchanged story, three live runs planned to create a test file that already
existed; the runs then reported the work as done, with all acceptance criteria passing, while no test had been
written. Every automated gate was green. The plan was the only place the problem could have shown up, and the plan did
not mention it.

**What changes:** a plan that chooses a path other than the one the story names must say so, in one line at the top,
and a plan that makes that substitution without declaring it is refused before it ever reaches you. Where the story
names something the plan cannot write, the plan refuses and gives its reason rather than quietly changing something
else instead.

**What this does not change:** the plan may still choose a different file, so this is not a ban on substitutions - it
is a ban on silent ones. The refusal machinery it needs may already exist (the AC4 gate and `refused-target` both
refuse with reasons today), so Task 4 verifies and pins what happens rather than adding a second refusal beside one
that works. This release does not make the choice deterministic - whether that is needed is what R4 measures. And it
does not change how a plan decides which file to target: R1 already governs that, and R3 governs only what must be
said about the decision.

## The requirement, and what R1 and R2 already did for it

Discovery already surfaces candidate artifacts. The plan must list them and state **which won and why**, at the **top
of the plan as one line**:

```text
Substituted: <chosen path> for <the surface the story names>, because <reason>
```

Where a story names a surface the plan **cannot** write, that is a **refusal carrying the reason**, never a silent
reroute to something writable.

R1 (#770, merged) made the action follow existence. R2 (#779, merged) bound the run to the approved set. **R3 is the
leg that makes the choice legible to the person approving it** - the reason for the choice already exists, but only a
careful reader finds it, and the plan's summary never mentions the action at all. That omission is how a misclassified
`create` survived three live runs of the same story.

## Recon, read rather than assumed

| what                                                       | where                                                                                                                            |
|:-----------------------------------------------------------|:---------------------------------------------------------------------------------------------------------------------------------|
| where the plan is rendered - so where the declaration goes | `agent/lib/dark-factory/plan-file.ts:266` - `renderPlanFile`                                                                     |
| where the choice rules decide                              | `agent/lib/dark-factory/plan-validator.ts:419` - `codes.push("target-role")`                                                     |
| the surface a story names                                  | `agent/lib/dark-factory/architect-discovery.ts` - `surface: { route, page }`, and the words a story uses for the default surface |

**And the useful find:** whether the `target-role` rule fired is **already tracked** -
`architect-agent.ts:895` documents a flag that is true *"when the target-role rule fired in ANY attempt, so exhaustion
reports an actionable reason"*. So the open question from #770 - whether that rule fires on the live path at all - is
answerable from existing data rather than needing a new investigation, and the declaration has something real to carry.

## Design

1. **The declaration is rendered at the top of the plan**, one line, from data the plan already has: the surface the
   story named, the path chosen, and the reason. Nothing new is discovered for it; the point is that it becomes
   visible at the top rather than implicit in the prose.
2. **A missing declaration is a refusal.** A plan that chose a path other than the surface the story names, without
   declaring the substitution, is refused. This is the enforcement, and it is what makes the declaration more than
   documentation. The validator already receives `surface` in its context, so it can make this call without new
   plumbing.
3. **The unwritable-surface path is verified and stated, not invented.** Refusals with reasons already exist in this
   codebase (the AC4 gate refuses a page-scoped story whose surface cannot be identified; `refused-target` refuses a
   plan that has left the repository). The task is to confirm what the named-but-unwritable case does today and to
   state it, rather than to add a second refusal beside ones that already work.

**Direction of safety, as the epic states it:** prefer refusing to routing around an obstacle. A substitution that
cannot be declared is refused rather than performed quietly, which is R2's "never widen the approved set" applied one
layer earlier - at the choice rather than the write.

## Tasks

### Task 1 (RED) - a plan that substituted without declaring is refused

A plan whose target is not the surface the story named, and which carries no declaration, is refused.

### Task 2 (control) - the same plan WITH a declaration proceeds

Without this, "refuse every substitution" would satisfy Task 1, and the declaration would be pointless.

### Task 3 - the declaration renders at the top, as one line

Asserted against the rendered plan, since *"both belong at the top of the plan as one line"* is the requirement's own
wording and a declaration buried in the approach prose would satisfy a looser test while missing the point.

### Task 4 - the unwritable named surface refuses with its reason

Confirm and pin what happens today for a named surface the plan cannot write, so this is a verified behaviour rather
than an assumption. If it already refuses with a reason, say so and pin it; if it reroutes, that is the defect this
task fixes.

### Task 5 - surface the `target-role` decision

Make the choice rule's decision visible in the same declaration (the flag at `architect-agent.ts:895` is the input),
which is the thread #770 left open: a choice already governed by a rule the approver cannot see.

## Verification

- RED then GREEN for each, with the control for Task 2.
- The rendered plan read back from a real render, not asserted against the renderer's inputs.
- `tsc --noEmit` clean, cspell over the changed files (not only the plan), the doc-drift guard if a module is added,
  and the full gate plus the coverage ratchet before any PR.

## Out of scope, stated rather than folded in

- **R4** (#781) - the reproducibility measurement. It decides whether a deterministic selector is warranted; this
  release must not get ahead of it.
- **A deterministic selector.** The epic's non-goal.
- **Any change to what the plan may target.** R3 governs what must be SAID about a choice, and R1 already governs how
  the choice follows existence. Changing the choice itself is exactly what R4 is for.
