# #444 - the smoke eval asserted the literal word "you"

**Issue:** #444
**Branch:** `fix/smoke-eval-assertion` (off `main` @ `f0aff99`, the #442 merge)
**Status:** RETROSPECTIVE - written after the change was implemented and pushed

## A note on this document

This plan was written after the implementation, at the user's request. It is not a GATE 1 artefact
and should not be read as one. The work went ahead on an explicit "implement option 1" instruction,
so the usual plan-first gate was skipped; recording it here keeps the decision and its evidence with
the branch, and keeps the omission visible rather than implicit.

## Acceptance

1. `smoke` passes for a reply that answers the greeting, without requiring the literal token "you".
2. It still fails when the agent says nothing useful - the check must not become an always-pass.
3. It never throws on an unexpected reply shape.

## The problem

`evals/smoke.eval.ts` asserted `includes("you")` against the reply to "Hello! What can you help me
with?". The word is in the prompt and the assertion expected it echoed. Production produced:

```text
Hi! I'm Eve Agent - here's what I can actually help with:
**General work** - Answer questions, analyze information, and search the web (with sources cited)
```

That is exactly what a smoke test exists to prove - the agent booted and said what it can do - and it
failed on vocabulary. Being a token test, it was also satisfied by any reply containing "you",
including a useless one.

## The decision

**Option 1, chosen by the user: assert the behaviour instead of the token.** The rejected Option 2
was to reword the prompt so a "you"-shaped answer is natural, which tunes the test to the
implementation rather than measuring what it cares about.

## The checks

- **C1** passes for the exact Production reply that failed - pinned, so the regression cannot return
- **C2** passes for a simple helpful greeting reply
- **C3** fails for an empty reply and never throws (empty, whitespace, null, undefined)
- **C4** fails for a reply that does not say what the agent can help with - anti-vacuity

## Approach

The verdict moves into `evals/helpers/smoke-reply.ts` with a unit test, following the helper
convention agreed for #440 so the assertion is testable outside CI, where the eval target cannot be
reached.

## Evidence

- **RED** `60f0711` - 2 failed | 2 passed, both on `AssertionError`, no collection error.
- **GREEN** `0168b86` - 4 passed; tsc exit 0; cspell clean.
- An earlier RED attempt was discarded: newline escapes in the heredoc became real newlines inside a
  double-quoted string, so the file failed to transform. A RED that fails for the wrong reason proves
  nothing, so it was not counted.

## Risks

- **The verdict is a proxy too.** "Says what it can help with" is a strong signal for a smoke test,
  but it is still a text heuristic. Stated so nobody reads it as a behavioural guarantee.
- **C1 pins a specific string** observed in Production. It will need updating if the greeting changes
  legitimately - which is the trade for pinning the regression.

## Out of scope

- The cost-budget reservation leak (#443).
- The model, the gate, or any environment configuration - this change touches an eval and a helper
  only, and needs no redeploy.

## Verification

The Preview Evals run is the authority: it should show `smoke` green.
