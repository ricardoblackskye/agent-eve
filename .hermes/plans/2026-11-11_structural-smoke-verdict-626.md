# Replace the smoke eval's keyword allow-list with a structural verdict (#626)

**Issue:** https://github.com/ricardoblackskye/agent-eve/issues/626
**Follows:** #624 / PR #625 (merged — widened the regex, still failed in production)
**Branch:** `feat/626-structural-smoke-verdict`
**Type:** test-only. No runtime path, schema or agent-behaviour change.

## Problem

The `smoke` eval on `main` still fails its reply gate. Three production runs, three wordings:

| Run | Reply opening | Matched the allow-list? |
| --- | --- | --- |
| original #444 | "here's what I can actually **help** with" | yes |
| after #478 budget top-up | "Here's what I **can do**" | no → #624, widened in #625 |
| after #625 merged | "**I can** dig into code and files, run commands, search the web" | no |

#625 added `can do` and `can help` to the regex and merged. The very next production run produced a
third phrasing that matches neither. Each widening buys exactly one run.

## Root cause: the assertion is a vocabulary test

`evals/helpers/smoke-reply.ts` matches a fixed word list against a **model-generated** sentence, while
nothing pins that sentence in `agent/instructions.md`. The model varies the phrasing freely, so the
allow-list is a moving target: every rewording is a false negative that only surfaces after a
production run.

The helper's own docstring, written in #444, states the intent:

> "It is a smoke test - boot plus a substantive greeting response - not a vocabulary test."

#444 replaced "the reply must contain the word *you*" with "the reply must contain help|assist|support".
That swapped one literal for another and reproduced the same failure mode. #624/#625 did it a third
time. The pattern, not the word list, is the defect.

## Fix: assert structure, not wording

`evals/helpers/smoke-reply.ts` — replace the single regex with three structural properties that hold
for any phrasing of "the agent booted and said what it can do":

1. **Non-empty** after trim — unchanged.
2. **Substantive length** — at least `MIN_SUBSTANTIVE_LENGTH = 40` characters. A bare greeting
   (`"Hi! I'm Eve Agent."`, 20 chars) fails, so the anti-vacuity guard survives without a word list.
3. **First-person capability claim** — the reply claims an ability in the first person:
   `I can`, `I'm able to`, `I am able to`, `I'm here to`. This is the structural shape "says what it
   can do" takes in all three observed greetings, including the one that currently fails.
4. **No refusal** — a reply containing `I can't`, `I cannot`, `I'm unable`, `I am unable` fails, so a
   decline is never mistaken for a capability statement.

Design notes:
- The first-person requirement is what makes this structural rather than lexical: it constrains the
  *form* of the sentence (a claim about the agent's own abilities) instead of the words inside it.
  "I can dig into code", "I can help", "I'm able to run commands" all satisfy it; "Hi! I'm Eve Agent."
  and "How are you?" do not.
- Length does the anti-vacuity work, so the capability check never has to enumerate capabilities.
- A refusal guard is needed because "I can't help with that" contains "help" — without it the old
  keyword approach read a decline as a capability statement.
- Failure messages stay specific (empty / too short / no capability claim / declined) so a genuine
  regression is diagnosable from the eval output instead of a bare "predicate did not hold".

## TDD sequence

1. **Red:** add the three production greetings as fixtures and assert all three pass, plus a refusal
   case that must fail. Run against the unchanged helper — the "I can dig into code" case and the
   refusal case must fail for the right reasons.
2. **Green:** implement the structural verdict. Re-run — all cases pass.
3. **Guard:** confirm empty / whitespace / null / undefined still fail without throwing, and the bare
   greeting still fails.

## Acceptance criteria

1. `evaluateSmokeReply` returns `ok: true` for all three observed production greetings:
   - `"Hi! I'm Eve Agent - here's what I can actually help with: …"`
   - `"Hi! I'm Eve Agent. Here's what I can do: …"`
   - `"Hi! I'm Eve Agent — I can dig into code and files, run commands, search the web, …"`
2. A bare greeting (`"Hi! I'm Eve Agent."`) returns `ok: false`.
3. A refusal (`"I'm sorry, I can't help with that."`) returns `ok: false`.
4. Empty, whitespace-only, `null` and `undefined` return `ok: false` and never throw.
5. `tests/eval-smoke-reply.test.ts` pins all three production phrasings so the next wording change is
   caught in CI, not only in production.
6. `npm test` (vitest) green; `npx tsc --noEmit` clean.
7. After merge, production evals on `main` report `smoke` 2/2 and the run 9/9.

## Out of scope

- Pinning the greeting phrasing in `agent/instructions.md`. The eval tolerates variation; it does not
  constrain the model's sentence.
- The `budget_exceeded` and `frontend` proxy-health causes — those were #478 and are resolved.
- Other evals' assertions. Only the smoke reply verdict changes.

## Risk

Low. One helper plus its unit tests. The production gate becomes *more* tolerant of wording and
slightly stricter about refusals and stubs, which is the intent. No production code is touched.
