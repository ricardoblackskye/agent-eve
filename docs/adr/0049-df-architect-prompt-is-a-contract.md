# 0049. The Architect's prompt is a contract, and a plan that cannot validate parks

**Status:** Accepted

**Date:** 2026-10-19

## Context

R1 gave the Architect eyes, and R2 made the right target required - and a live run against WebFeedPOC #169 then
failed in a way neither covered. Discovery resolved the surface correctly: route `/` to `src/pages/HomePage.jsx`,
with `src/App.jsx` held as a shell. The plan came back naming five files the repository does not contain:
`src/components/Header.js`, `src/components/Footer.js`, `src/App.js`, `src/App.test.js`, `src/index.js`.

The cause was one line of prompt: *if the story touches UI/Chat (mentions "chat ui", "user navigates", "page",
"browser", "screen"), targetFiles MUST include UI entrypoints under app/ or components/*. The story said "on the
main page", so the instruction ordered the model at the shared components - the files R2 exists to refuse - and
offered Next.js paths as its example. Nothing had ever watched that line fail, because it was an anonymous string
inside a 900-line class. Validation then failed on a missing `action` field, both repair rounds were spent, and
the run **aborted**.

## Decision

Treat the Architect's prompt as a contract, and enforce it rather than request it.

1. **The rules about targets live in their own module** (`architect-prompt.ts`) as a pure function, so prompt
   behaviour is testable on its own. For a page-scoped story the resolved page is **mandated**, the shell and
   shared files are named **forbidden** with the reason, and every target path must appear in the file list. The
   `app/` + `components/` guidance survives only as a fallback used when discovery resolved no page.
2. **Existence is validated, not asked.** `PlanValidationContext` accepts the repository's file list, and a
   target absent from it raises a `target-missing` error naming the path. Mechanical rules belong in the
   validator: the contract is advice, the validator is the enforcement.
3. **A plan that never validates parks instead of aborting**, reporting `plan-invalid` with its validation errors
   on the ticket. A person can answer "the target should be X"; a terminal failure threw that away. Aborting
   stays reserved for faults a human cannot answer.

## Consequences

- The invariant is now checkable: a plan cannot name a file the repository does not contain, whatever the model
  says and whatever the prompt left out.
- Prompt regressions are testable. The line that caused this would fail a test today, which is the difference
  between a rule and a hope.
- The contract is sent only when it fits the prompt budget. When it does not, the validator still holds - which
  is exactly why dropping it is safe, and why the contract does not need to be reserved out of the evidence
  budget.
- A parked run holds its issue's claim until a human answers. Two more parked states make an operator path to
  release a stale claim more valuable than it was before.
- The reason vocabulary grows with the failure modes rather than collapsing them: `unresolved-surface`,
  `refused-target`, `plan-invalid`, each asking its own question.
