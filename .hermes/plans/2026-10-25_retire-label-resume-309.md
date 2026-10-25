# Plan — #309: Retire the `needs-answer` label-clear resume path

- **Date:** 2026-10-25
- **Issue:** #309 (DF P1 — sub-issue of #306, in Epic #267)
- **Branch:** `fix/retire-label-resume-309`

## Goal

Make the comment reply the **only** way to resume a parked Dark Factory run. Clearing the
`needs-answer` label must stop resuming the run.

## Root cause (verified)

`agent/lib/dark-factory/trigger.ts` returns a `resume` decision when the `needs-answer`
label is **cleared** (lines 280-286):

```ts
if (labelName === questionLabel) {
  return decide(
    "resume",
    `the question label was cleared on ${clamp(repo)}#${issue}; resuming the parked run`,
    where,
  );
}
```

ADR 0022 deliberately kept this as a second, legacy resume path "for one release so the new
[comment] path can be proven", then retire it. The comment path (#306 / ADR 0022) is the
documented, only-supported path now.

## Acceptance criteria

- [ ] **AC1 (DEFERRED — see Risks):** comment-reply path exercised in a real UAT run. The
      operator has explicitly overridden the deferral and asked to proceed; AC1 is recorded
      as still-open in ADR 0064.
- [x] **AC2:** clearing `needs-answer` no longer resumes. Decision becomes `not-a-trigger`
      with a reason that names the retirement.
- [x] **AC3:** trigger vocabulary + ADR 0022's "two resume paths" consequence updated; a NEW
      ADR (0064) **supersedes** accepted ADR 0022, recording the comment reply as the only
      resume path.
- [x] **AC4:** tests cover both directions — a comment resumes; a cleared label does not.
- [x] **AC5:** grep confirms no other caller depends on the label path (only `trigger.ts`).

## Intended fix

1. `agent/lib/dark-factory/trigger.ts` — replace the `labelName === questionLabel` `resume`
   block with a `not-a-trigger` decision whose reason names the retirement (e.g.
   `... the needs-answer label was cleared ... the label-clear resume path is retired (#309);
reply on the issue to resume a parked run`). The `isQuestionLabel` guard (line 193) stays
   so a cleared question label still falls through to this branch (not the abort branch).
2. `agent/lib/dark-factory/plan-approval.ts` — update the doc comment (line 10, "or a cleared
   `needs-answer` label") and `PLAN_APPROVAL_QUESTION` (line 24, "or remove the
   `needs-answer` label") so the human is told the comment is the only resume path.
3. `tests/dark-factory/entry.test.ts` — the four resume tests currently drive the run with a
   `unlabeled` `needs-answer` decision. Switch them to a **comment** decision
   (`{ action: "created", comment: { body: "approved" } }`) so they keep proving "resume
   works" via the only remaining path. Behaviour under resume is unchanged.
4. New `tests/dark-factory/label-resume-retired.test.ts` (RED) — asserts
   `decideDarkFactoryTrigger({ action: "unlabeled", label: "needs-answer" })` is
   `not-a-trigger` with a retirement reason, and that the dispatch does not resume / post.
5. ADR `0064-retire-label-clear-resume-path.md` superseding 0022 + README index link.

## TDD phases

- **RED:** `label-resume-retired.test.ts` fails against current code (which returns `resume`).
- **GREEN:** apply changes 1-5; the new test passes and the switched entry tests still prove
  resume via comment. Full Vitest suite green.

## Files likely to change

- `agent/lib/dark-factory/trigger.ts`
- `agent/lib/dark-factory/plan-approval.ts`
- `tests/dark-factory/entry.test.ts`
- `tests/dark-factory/label-resume-retired.test.ts` (new)
- `docs/adr/0064-retire-label-clear-resume-path.md` (new)
- `docs/adr/README.md`

## Validation

- `npx vitest run tests/dark-factory/label-resume-retired.test.ts`
- Full suite (`npx vitest run`) — no regression in the 4 switched resume tests.
- `npx tsc --noEmit`
- `npx cspell@9.1.1 -c .cspell.json <changed files>`
- `prettier@3 --check` on changed files

## Risks / open questions

- **AC1 unmet:** per the issue's own deferral, this should land only after a real UAT run of
  the comment path. The operator has overridden and asked to proceed. Risk: if the comment
  path has a latent production defect, clearing the label will no longer be a fallback.
  Mitigation recorded in ADR 0064 — the comment path is fully unit/integration tested
  (ADR 0022, `entry.test.ts`), and the dashboard "Resume" still resumes a paused run; only
  the label-clear inbound webhook path is removed.
