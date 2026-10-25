# 0064 — The comment reply is the only Dark Factory resume path

- **Date:** 2026-10-25
- **Status:** Accepted
- **Supersedes:** [0022](0022-comment-answer-resumes-a-parked-run.md)

## Context

ADR 0022 introduced the comment-reply resume path for parked Dark Factory runs and, for one
release, deliberately kept the pre-existing **label-clear** resume path (clearing the
`needs-answer` label) as a second, legacy path "so the new path can be proven". ADR 0022
stated the label path "should be retired once it is [proven]".

Two resume paths are a latent hazard: an operator who clears the `needs-answer` label — for
any reason (triage, false positive, noise) — silently restarts a parked run through an
undocumented action, and the two paths can diverge in behaviour. Issue #309 retires the
label path.

## Decision

The comment reply is now the **only** resume path.

- `decideDarkFactoryTrigger` no longer returns `resume` when the `needs-answer` label is
  **cleared**. It returns `not-a-trigger` with a reason that names the retirement and points
  the operator to the comment path (#309).
- The plan-approval message (`PLAN_APPROVAL_QUESTION`) and the module's resume-side doc
  comment no longer tell the human that removing the label resumes the run.
- The `isQuestionLabel` guard in the trigger is retained so a cleared question label still
  falls through to the `not-a-trigger` branch (and is never mistaken for the trigger-label
  abort branch).

Resuming still works exactly as before through a comment reply: a comment by an allow-listed
actor on the parked issue is correlated by issue plus arrival order and idempotently resumes
the `blocked` run, carrying the answer as DATA.

## Consequences

- Clearing `needs-answer` is now a no-op for the factory — it neither resumes nor aborts;
  it only removes a label, which the operator can do freely without restarting work.
- One documented resume path remains, matching the single-trigger-style discipline elsewhere
  in the repo.
- **AC1 of #309 (a real UAT run of the comment path) is intentionally still OPEN.** The
  operator chose to proceed before UAT, accepting the residual risk that a latent production
  defect in the comment path would leave no label-based fallback. Mitigations: the comment
  path is fully unit- and integration-tested (ADR 0022, `entry.test.ts`), and the dashboard
  "Resume" still resumes a paused run directly — only the inbound `needs-answer` label-clear
  webhook path is removed.
