# Plan — #191: PR reviewer retries transient model errors (no more structural fallback)

**Issue:** [#191](https://github.com/ricardoblackskye/agent-eve/issues/191)
**Branch:** `fix/pr-reviewer-transient-retry-191`
**Type:** bug fix (+ carried lint debt)

## Goal

On a transient model failure (e.g. OpenRouter HTTP 429) the reviewer currently
posts the **structural fallback** and the job has to be re-run by hand. Make the
reviewer **retry transient failures** (bounded, with backoff) so it normally
produces a real review, and fall back only once retries are exhausted. Also
clear the pre-existing lint findings that #190 surfaced.

## Root cause (verified from the PR #190 job log)

- `OpenRouter response status: 429`; body: `deepseek/deepseek-chat is
temporarily rate-limited upstream`, `limit_source: "upstream_provider_shared_pool"`
  (providers StreamLake then DeepInfra both 429'd).
- The script retries **only** when `finish_reason === "length"` (the #87
  reasoning-budget case). Every other failure — HTTP 429/5xx, empty content, or
  a transport error — falls straight through to `generateFallbackReview(...)`
  with **no retry**. One 429 ⇒ structural fallback; a manual re-run succeeds.

## Scope A — resilience (the bug)

1. **Bounded retry with exponential backoff (+ jitter)** around the OpenRouter
   call for **transient** failures: HTTP 429/5xx, network/transport errors, and
   empty-content responses that are _not_ `length`. Honour `Retry-After`.
2. **Do NOT retry non-transient failures** (400/401/403 — a bad key/request must
   surface, not loop forever).
3. **Request timeout** on the OpenRouter call (the diff fetch already has one).
4. **`concurrency:` group** on `.github/workflows/pr-reviewer.yml` (e.g.
   `pr-reviewer-${{ github.event.pull_request.number }}`, `cancel-in-progress:
true`) so `opened` + `synchronize` can't double-fire into the shared pool.
5. **Provider routing** — send `provider: { sort: "throughput" }` (or an
   explicit `order`) to reduce shared-pool 429s; document BYOK as the robust
   fix. Retry knobs env-overridable: `PR_REVIEW_MAX_ATTEMPTS`,
   `PR_REVIEW_RETRY_BASE_MS`.

### TDD (Scope A)

The script is a top-level program (side effects on import), so the retry policy
goes in a **small pure module** with real unit tests; the script wires it in.

- **RED (unit)** `tests/pr-reviewer-retry.test.ts` for `scripts/pr-reviewer-retry.ts`:
  - `isTransientModelError({ status, body })` → true for 429/500/502/503/504 and
    for a thrown network error; false for 200/400/401/403; true for empty-content 200.
  - `retryDelayMs(attempt, retryAfterMs?)` → exponential from a base, capped,
    never negative, honours a supplied `Retry-After`.
  - `parseRetryAfter(value)` → seconds / HTTP-date → ms.
- **GREEN:** implement the module; wire a **bounded retry loop** into
  `scripts/pr-reviewer.ts` around the OpenRouter fetch (reuse it for the existing
  length-retry path).
- Add **source-text assertions** in `tests/pr-reviewer.test.ts` (matching the
  existing style) for the wired retry loop and the workflow concurrency group.

## Scope B — carried lint debt (surfaced on #190; all pre-existing on `main`)

1. `README.md` — `markdown-table-formatter` wants the tables reformatted
   (`npx markdown-table-formatter --write README.md`).
2. `README.md:475` — `MD018/no-missing-space-atx`: the line starts with `#146 …`
   and reads as a malformed heading. Reword so it no longer begins with `#`
   (e.g. prefix "Issue " or make it a bullet).
3. `.github/workflows/pr-reviewer.yml` — `prettier --check` is dirty
   (`npx prettier --write`); fixed together with the concurrency change.

## Files likely to change

- `scripts/pr-reviewer-retry.ts` (new) — pure retry policy
- `scripts/pr-reviewer.ts` — bounded retry + timeout + provider routing
- `.github/workflows/pr-reviewer.yml` — concurrency group + prettier
- `tests/pr-reviewer-retry.test.ts` (new)
- `tests/pr-reviewer.test.ts` — source-text assertions
- `README.md` — table formatting + MD018 + retry env docs

## Validation

- `npx vitest run` — full suite green; `npx tsc --noEmit` — clean.
- Local lint gate: `cspell@9`; `prettier --check` on changed files;
  `markdown-table-formatter --check README.md`; markdownlint on changed `.md`
  (note MD013 is disabled in MegaLinter's config).
- Sanity: `npx tsx scripts/pr-reviewer.ts` still boots (fails only on the
  missing `GITHUB_EVENT_PATH`).

## Risks / open questions

- Retry adds latency — keep attempts small (e.g. 3) and cap the delay.
- Retrying must not mask a genuine config error (bad key / 400) — classify strictly.
- OpenRouter's 429 `Retry-After` hint arrives in the **body** (`error.metadata`),
  not a header; parse both the header and the body.
- Scope B edits files unrelated to the feature — this PR is deliberately a
  "reviewer robustness + carried lint" bundle, as requested.
