# 0059 — A repair stays grounded in the target repository

- **Date:** 2026-10-24
- **Status:** Accepted

## Context

While proving #405 against a live run on `ricardoblackskye/WebFeedPOC#172`, the Architect's plan
attempts drifted after the first rejection. Attempt 2 described **`agent-eve` itself** — targets
`agent/lib/dark-factory/architect-agent.ts`, a timeout constant, and acceptance criteria about
timeouts — while the story was *"create a new sub-heading on the main page"* for WebFeedPOC.

The cause was not the discovery read. Reads were provably rooted at the target: validation was
handed WebFeedPOC's 254 files. The cause was the **repair prompt**. `buildRepairPrompt` forwarded
only the story *number*, the previous raw output and the validation errors. It never carried the
story narrative, the discovered repository structure, or the evidence/contract that
`buildInitialPrompt` — and the amendment path, which reuses it — does inject. So the initial attempt
was grounded in the target repository and every retry was not. A model asked to repair a plan with
no repository context filled the gap from its own association with "Architect Agent" and invented a
plan for `agent-eve`. The invented file and constant were hallucinated, not leaked: nothing in the
repair prompt referenced this repository's source.

The human was then shown that wrong-repository plan at park time, so the harm was not only wasted
tokens but a park message describing a repository the run was never working on.

Separately, the validator already emitted `target-missing` when a plan tried to `modify`/`replace`
a path absent from the discovered file list, but the retry loop folded only `target-role` into its
refusal classification. A plan that had left the target repository was therefore retried as
`plan-invalid` — spending the remaining budget on a plan that could never succeed.

## Decision

**The repair prompt carries the same grounding as the initial prompt.** `buildRepairPrompt` now
receives the discovered `repoFiles`, the discovery evidence section and the target contract, and
emits them before the validation errors: the story narrative in `<user_story>` containment, the
`### REPOSITORY STRUCTURE:` list, `### REPOSITORY EVIDENCE:` and the mechanically-checked
`### TARGET CONTRACT`. It also states the directive explicitly: *this repair must target the SAME
repository listed below*. Both call sites supply the grounding — `planStory` from discovery, and
`amendPlan` from the file list it already reads (the amendment path has no evidence/contract
section, which was already true of its initial prompt).

**A plan that leaves the discovered set is a refused target, not an invalid plan.** In the shared
plan loop, `target-missing` now sets the refusal flag when a file list was supplied, so exhaustion
reports `refused-target`. The reason a plan cannot be fixed by retrying is the same reason a
wrong-repository plan is not a plan: it is aimed somewhere the run is not working.

The cost is bounded. The structure list is capped by the existing `maxContextFiles`, and the repair
prompt is proportional to the initial prompt that already fits `promptBudget()`; no new read and no
new model call is introduced. The change is additive to the prompt and to the classification.

## Consequences

- A retry cannot silently change repository. The story, the discovered structure, the evidence and
  the contract are load-bearing on every attempt, not only the first.
- A repair that proposes a file outside the discovered set fails as `refused-target`, so the park
  message names the real problem and the operator is not shown a plan about another repository.
- The amendment path is grounded too, because it shares the same repair builder. An amendment
  cannot lose the target after a rejected revision.
- **This changes the classification #381 R2 Task 8 established.** A plan whose only failure is a
  target outside the discovered set used to be reported as `plan-invalid`; it is now
  `refused-target`. The two tests that asserted the old outcome were updated deliberately, and a
  new control keeps `plan-invalid` covered for failures that are NOT about the target (a real file
  with a missing AC mapping). The reason a repair cannot fix a wrong-repository plan is the same
  reason a human must be asked, not retried.
- **A `create` target is exempt from the existence rule by design** — a create is meant to be a new
  file — so Slice B does not catch a `create` of a wrong-repository path. That case is mitigated by
  the grounding in Slice A; extending existence to `create` paths would be a separate decision.

## Alternatives considered

- **Raise the retry count.** Rejected: more attempts on a plan aimed at the wrong repository spend
  more tokens to produce the same wrong answer. The fix is to keep the target load-bearing, not to
  try harder.
- **Ground only the story narrative and not the file list.** Rejected: the structure is the signal
  the validator enforces against; without it a retry cannot know which repository it is repairing.
- **Classify every `target-missing` as refused-target.** Rejected: without a supplied file list the
  validator cannot distinguish a missing file from an unreadable repository, so the classification
  stays conditional on evidence having been seen.
- **Re-plan from scratch on rejection.** Rejected: a fresh plan is not the plan the human was shown,
  and it discards the rejection's reason — the opposite of a repair.
