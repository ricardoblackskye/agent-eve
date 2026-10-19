# 0048. A page-scoped story is not planned against the shell, and an unjustifiable target parks

**Status:** Accepted

**Date:** 2026-10-19

## Context

R1 gave the Architect eyes: bounded reads, deterministic discovery, evidence carried into the prompt. That made
a better target **likely**. Nothing acted on the evidence, so a plan could cite it, ignore it, and still be
accepted - which is how `src/App.jsx`, the application shell, became a target in WebFeedPOC #168 round 2 with a
confident rationale behind it. R2 makes the right target **required**.

## Decision

1. **Scope classification, and the shell reading wins.** `isPageScopedStory` returns false whenever
   `isShellScopedStory` is true, because the shell reading only ever *allows* a target while the page reading
   only ever *refuses* one. A false positive on the shell side therefore cannot block a legitimate change, and
   the asymmetry is the safety property rather than an oversight. The word "page" in a non-UI context (page
   size, page count, pagination, offset) is stripped before the surface signals are tested, so a database story
   is not read as being about a screen.
2. **The refusal is a plan rule with an optional context.** `validateExecutionPlan(plan, storyText, context?)`
   stays a pure function of its arguments, and every existing caller behaves exactly as before. It refuses a
   `shell` or `shared` target for a page-scoped story and names four things: the file, what it IS, the evidence
   that proves the role, and the page to use instead. A repair round told only "wrong target" simply re-guesses,
   which is the failure this rule exists to stop.
3. **Validation receives the title as well as the body.** The surface a story names is often only in the title,
   and validating on the body alone meant the rule never fired on the exact stories that failed.
4. **An unjustifiable target parks, and asks its own question.** A page-scoped story whose surface cannot be
   identified produces `reason: "unresolved-surface"` **before any model call** - fail-closed by construction,
   and free. A plan that still targets the shell after the repair rounds produces `reason: "refused-target"`.
   Both park through the existing `parkForApproval`, so the run stays `blocked` and resumable, because the
   human's answer may simply be that the shell IS correct. The park asks `TARGET_UNRESOLVED_QUESTION`, not the
   approval question: there is no plan to approve, and asking a human to approve one that does not exist is how
   a park becomes noise.
5. **Parking requires evidence actually SEEN.** The gate needs non-blank content, not merely that discovery ran.
   Discovery classifies a `page.tsx` by path even when the file is empty, so without this a repository whose
   contents cannot be read looks like evidence of "no page here" and every run against it parks.

## Consequences

Two defects were caught by tests written first, and neither would have been caught by reading the diff:

- The rule never fired at all, because validation used `story.body` while the surface lived in the title.
- The parking gate fired on unread evidence, and five pre-existing tests failed on it - which is how the
  distinction between "there is no page here" and "nothing could be read" was found.

R1 measured this repository at 718 files and **no chain**, because its routes are implied by file paths. A repo
of that shape resolves no surface, so its page-scoped stories park. That is fail-closed and correct in
principle, and noisy in practice: extending discovery to path-implied routes is a follow-up issue, not solved
here.

The repair budget is unchanged (`maxPlanRetries: 2`). A refusal costs one round, which is tolerable precisely
because the refusal names the page the plan should use.

Approval semantics are untouched: #378 / ADR 0041 remains the only path that reaches coding, and R2 adds no new
way to approve anything.
