# Plan: PR reviewer must not silently degrade to a stub (#87)

**Status:** PLAN — GATE 1 (user pre-cleared: "you can then work on this small change")
**Branch:** `fix/pr-reviewer-reasoning-budget-87` (off `origin/main` @ `7ca1a58`)
**Type:** bug fix (CI tooling)
**Closes:** #87

---

## Root cause (verified from the CI log on PR #148)

```text
OpenRouter response status: 200
OpenRouter returned no message content (finish_reason: length, reasoning length: 16068),
using fallback review.
```

- **HTTP 200** — the model WAS reachable. This is *not* a rate-limit/outage, despite
  the script (and the stub comment it posts) claiming "the AI model was unavailable".
- **`finish_reason: length`** — the completion hit `max_tokens`.
- **`reasoning length: 16068`** (characters ≈ ~4,000 tokens) — a reasoning model put
  its entire `max_tokens: 4000` budget into the hidden `reasoning` field and emitted
  **no** `content`. `content` is null on a successful call.
- The script then posts `generateFallbackReview(...)` — a structural stub.

**Why it regressed now:** the #121 model swap moved the reviewer to
`deepseek/deepseek-v4.1-flash`, which reasons harder than `deepseek-v4-pro` on the
same input. The existing guard `reasoning: { effort: "low" }` is a **hint, not a hard
cap**, so the whole 4k budget got spent thinking. Input handling is already fine
(docs stripped; diff truncated 78,514 → 19,979 chars).

**Why it's intermittent:** reasoning length is non-deterministic (historically 0 /
~5.5k / ~17k tokens for the same diff), so some runs finish inside budget and produce
a real review while others return nothing.

---

## Fix

1. **Hard-cap reasoning tokens** — replace the effort-only hint with an explicit
   token cap: `reasoning: { max_tokens: REVIEW_REASONING_MAX_TOKENS }` (default
   1500). The answer then always has room, regardless of how much the model wants
   to think. NOTE: OpenRouter rejects a request that sets BOTH `reasoning.effort`
   and `reasoning.max_tokens` (HTTP 400 — found on PR #149), so the cap is sent
   ALONE.
2. **Raise `max_tokens`** to 6000 so `reasoning cap + a full review` fits
   (env-overridable via `PR_REVIEW_MAX_TOKENS`).
3. **Retry once instead of degrading to the stub** — on `null content` with
   `finish_reason: "length"`, retry a single time with the diff halved. This is the
   behaviour #87 asks for ("retry … instead of falling back to stub").
4. **Correct the message** — the fallback must not claim the model was unavailable
   when the real cause was an output-budget exhaustion. Report the cause precisely
   (and keep the model-outage wording only for genuine transport failures).

---

## Files likely to change

- `scripts/pr-reviewer.js` — reasoning cap, `max_tokens`, bounded retry, accurate
  fallback wording.
- `tests/pr-reviewer.test.ts` — tighten the existing invariants (see below).

## Tests

Existing tests for this script are **source-regex** assertions (it is a top-level
script, not an importable module) — e.g. `max_tokens >= 4000`,
`reasoning: { effort: "low" }`, `stripDocsFromDiff`, `truncateDiff(codeDiff)`.
They all still pass while the reviewer fails, so they do not capture this bug.

RED (new invariants, which fail today):

- reasoning must carry an explicit **`max_tokens` cap** (not just `effort`).
- `max_tokens` must be ≥ 6000 (so a capped reasoning budget leaves room).
- the script must contain a **retry** path for the length-exhausted case.
- the fallback text must be cause-accurate (not "model was unavailable" for a budget
  problem).

GREEN: implement the four changes; re-run the file, then the full suite.

> Note the honest limitation: these are still regex assertions. The follow-up that
> would make them behavioural is extracting the request-builder + response
> classifier into a small module and testing it directly — out of scope for this
> "small change" but worth a ticket if the reviewer keeps biting.

## Validation

- `npx vitest run tests/pr-reviewer.test.ts` → RED then GREEN.
- `npm test` → no regressions (currently 372 passed / 2 skipped).
- `npx tsc --noEmit` → clean.
- `npx -y cspell@8 --config .cspell.json scripts/pr-reviewer.js tests/pr-reviewer.test.ts` → clean.
- **Live proof:** the `pr-reviewer` CI check on this PR must post a *real* review
  (not "(Fallback Mode)"), which I will confirm from the workflow log.

## Risks / open questions

- If the model ignores `reasoning.max_tokens`, the retry is the safety net (and the
  smaller-diff retry reduces reasoning pressure as well).
- I base this branch on `origin/main` @ `7ca1a58`; the R2 merge (#148) does not touch
  `scripts/pr-reviewer.js`, so I'll rebase onto the latest `main` before pushing.
