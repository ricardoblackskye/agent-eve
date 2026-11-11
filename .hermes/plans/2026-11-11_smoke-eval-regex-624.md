# Fix the smoke eval's greeting acceptance regex (#624)

**Issue:** https://github.com/ricardoblackskye/agent-eve/issues/624
**Branch:** `feat/624-smoke-eval-regex`
**Type:** test-only fix. No production behaviour changes.

## Problem

The last failing production eval gate on `main` is `smoke` 1/2:

```
✗  smoke  gates 1/2
  ✓ succeeded (100%)
  ✗ satisfies(the reply does not say what the agent can help with: Hi! I'm Eve Agent. Here's what I can do:)
```

The agent boots and replies substantively. The verdict rejects the reply because the acceptance
regex in `evals/helpers/smoke-reply.ts` is a literal vocabulary check:

```ts
const SAYS_WHAT_IT_CAN_DO = /help|assist|support/i;
```

The live greeting — `Hi! I'm Eve Agent. Here's what I can do:` — contains none of those words, so a
valid answer fails. The phrasing is not pinned in `agent/instructions.md`; the model legitimately
varies it, so the regex is coupled to one sampled wording.

## Why this is the eval's bug, not the agent's

`evals/helpers/smoke-reply.ts` was introduced by #444 to replace an equally brittle assertion (the
reply had to contain the literal word "you"). Its own docstring states the intent:

> "It is a smoke test - boot plus a substantive greeting response - not a vocabulary test."

Requiring a specific word reproduced the same failure mode one level down: a fixed literal swapped
for a different fixed literal. The guard we actually want is "the reply names at least one thing the
agent can do" — phrasing-agnostic.

## Fix

`evals/helpers/smoke-reply.ts` — widen the acceptance set to include the agent's real phrasing while
keeping the anti-vacuity guard:

```ts
const SAYS_WHAT_IT_CAN_DO = /help|assist|support|can do|can help/i;
```

Notes:
- `can do` covers the live production greeting; `can help` covers the #444 fixture wording
  explicitly rather than relying on the bare `help` alternative matching mid-phrase.
- A bare greeting (`Hi! I'm Eve Agent.`) still contains none of these, so C4's anti-vacuity guard
  still fails as intended. The guard's purpose — "replied AND said what it can do" — is preserved.
- The failure message stays as-is so a genuine regression is still diagnosable from the eval output.

## TDD sequence

1. **Red:** add a regression case to `tests/eval-smoke-reply.test.ts` asserting the exact live reply
   (`Hi! I'm Eve Agent. Here's what I can do:`) passes. Run it against the unchanged regex — it must
   fail for the right reason.
2. **Green:** widen the regex. Re-run — the new case and C1-C4 all pass.
3. **Guard:** confirm C3 (empty / whitespace / null / undefined) and C4 (bare greeting) still fail.

## Acceptance criteria

1. `evaluateSmokeReply("Hi! I'm Eve Agent. Here's what I can do:")` returns `ok: true`.
2. The #444 production reply (`here's what I can actually help with:`) still returns `ok: true`.
3. Empty, whitespace-only, `null` and `undefined` still return `ok: false` and never throw.
4. The bare greeting `Hi! I'm Eve Agent.` still returns `ok: false`.
5. `tests/eval-smoke-reply.test.ts` covers the live phrasing verbatim, so a future wording change is
   caught in unit tests rather than only in production.
6. `npm test` (vitest) green, typecheck clean, doc-drift guards green.
7. After merge, the production evals report `smoke` 2/2 and the run is 9/9.

## Out of scope

- Pinning the greeting phrasing in `agent/instructions.md`. The eval should tolerate phrasing
  variation, not force the model into one sentence.
- The `frontend` proxy-health 500 and the `budget_exceeded` refusals. Those were the two causes
  behind #478 and are tracked/handled there; this issue is the separate assertion-level false
  negative that only became visible once the run reached the agent again.
- Broadening other evals' assertions. Only the smoke reply verdict is in scope.

## Risk

Low. Test-only: one regex in an eval helper plus one unit-test case. No runtime path changes, no
schema changes, nothing shipped to the agent.
