# Plan — #189: Refactor PR reviewer (delete orphaned subagent + convert script to TypeScript)

**Issue:** [#189](https://github.com/ricardoblackskye/agent-eve/issues/189)
**Branch:** `refactor/pr-reviewer-subagent-ts-189`
**Type:** refactor (behaviour-preserving migration + dead-code deletion)

## Goal

Collapse the PR reviewer into **one** implementation: delete the unused Eve
subagent, and bring the live CI script (`scripts/pr-reviewer.js`) under the
project's type checker by converting it to TypeScript — with **zero behaviour
change**.

## Background (why the split exists)

- `agent/subagents/pr-reviewer/` — the _original_ Eve subagent
  (`agent.ts` 18 lines + `instructions.md`). Auto-discovered by Eve but
  **nothing routes a review to it** (no import/delegation anywhere). It has
  drifted: the #182/#183 quality work (runtime grounding, anti-hallucination,
  severity tagging) lives only in the script.
- `scripts/pr-reviewer.js` (542 lines) — the **live** reviewer, run by
  `.github/workflows/pr-reviewer.yml` (`node scripts/pr-reviewer.js`). It is
  **not** type-checked today (tsconfig `include` lists `scripts/**/*.ts` only).

## Why this is a "mechanical migration" (TDD framing)

`tests/pr-reviewer.test.ts` is **30 source-text assertions** (~27 reads of the
script by path, plus a subagent `describe`) — it is the **regression oracle**,
not a set of behaviour tests. So per the SDLC skill's _Mechanical migrations_
section:

- **RED anchor:** after the rename to `.ts`, `npx tsc --noEmit` FAILS on the new
  file (strict errors on 542 lines of loose JS) — and the tests that still reference the old
  `.js` fail to read a now-missing file.
- **GREEN:** `tsc --noEmit` clean **and** the full suite still passes, with every
  asserted identifier/string **byte-identical**.

### Contract to preserve (asserted by the suite — do NOT rename or reword)

`// Synchronous is acceptable at startup`, `REVIEW_MODEL = process.env.PR_REVIEW_MODEL ||
"deepseek/deepseek-chat"`, `model: REVIEW_MODEL,` (exactly 2), `REVIEW_MAX_TOKENS`,
`REVIEW_REASONING_MAX_TOKENS`, `reasoning: { max_tokens: REVIEW_REASONING_MAX_TOKENS }`,
`MAX_DIFF_CHARS`, `sanitizeForPrompt`, `stripDocsFromDiff`, `truncateDiff`,
`finishReason === "length"`, `retryWouldBeIdentical`, `generateFallbackReview(...reason)`,
`filterFalsePositives`, `PR_REVIEW_VERIFY`, `formatStructuredReview`, `[BLOCKER]`,
`[SUGGESTION]`, `VERIFY BEFORE ASSERTING`, `DO NOT NITPICK OR DICTATE TASTE`,
`single-threaded`, `LGTM`, `User-Agent`, `AbortSignal.timeout|signal:`.

## Tasks

### Phase A — delete the orphaned subagent (RED→GREEN, small)

1. **RED:** remove `"pr-reviewer"` from `SUBAGENTS` in
   `tests/subagent-model-source.test.ts` → the runner then tries to read a
   missing `agent/subagents/pr-reviewer/agent.ts` and fails.
2. Delete `agent/subagents/pr-reviewer/` (`agent.ts`, `instructions.md`).
3. Remove the `Agent Definition (agent/subagents/pr-reviewer/agent.ts)` describe
   block from `tests/pr-reviewer.test.ts`.
4. **GREEN:** full suite passes.

### Phase B — convert the script to TypeScript (migration)

5. **RED:** `git mv scripts/pr-reviewer.js scripts/pr-reviewer.ts`; run
   `npx tsc --noEmit` → expect strict errors on the new file.
6. Add types only (interfaces for the GitHub event, the OpenRouter request/
   response, helper params/returns). No logic changes, no identifier renames.
7. Update every `scripts/pr-reviewer.js` path in `tests/pr-reviewer.test.ts`
   (27 occurrences) → `.ts`.
8. Update `.github/workflows/pr-reviewer.yml`:
   `node scripts/pr-reviewer.js` → `npx tsx scripts/pr-reviewer.ts`
   (`tsx@^4` is a devDependency, installed by the workflow's `npm ci`; keeps
   Node `22`, which a test asserts).
9. **GREEN:** `npx tsc --noEmit` clean; full suite green.

### Phase C — docs

10. README: note the PR reviewer is a TS script (`scripts/pr-reviewer.ts`) run by
    the Action, and that the Eve subagent was removed.

## Files likely to change

- `agent/subagents/pr-reviewer/agent.ts` + `instructions.md` — **deleted**
- `scripts/pr-reviewer.ts` — **renamed from `.js`**, now typed
- `.github/workflows/pr-reviewer.yml` — run via `tsx`
- `tests/pr-reviewer.test.ts` — remove subagent block; update 27 paths
- `tests/subagent-model-source.test.ts` — drop `pr-reviewer` from `SUBAGENTS`
- `README.md` — document the single TS implementation

## Validation

- `npx tsc --noEmit` — clean (this is the primary RED→GREEN oracle).
- `npx vitest run` — full suite green (pr-reviewer source-text suite + the
  rest). No regressions.
- Local lint gate before push: `npx -y cspell@9 --config .cspell.json <changed
files>` + prettier on changed files.
- Sanity: `npx tsx scripts/pr-reviewer.ts` fails **only** on the missing
  `GITHUB_EVENT_PATH` (proving the module loads/runs under tsx, no TS/import
  errors).

## Risks / open questions

- **Strict typing effort:** `strict: true` will surface many implicit-`any` /
  possibly-undefined errors across 542 lines. This is the bulk of the work;
  resist changing logic to silence the compiler.
- **tsconfig compatibility:** `target ES2022` + `module esnext` supports the
  script's top-level `await`; `isolatedModules` is satisfied because the file is
  already an ES module (it has imports).
- **CI runtime:** the workflow must run via `tsx`; verify the Action still
  triggers and passes on `pull_request`. Keep Node `22` (a test asserts it).
- **Out of scope (possible follow-up):** replacing the source-text tests with
  real unit tests — the script has top-level side effects (`process.exit`, reads
  `GITHUB_EVENT_PATH`), so importing it requires a larger refactor (guard the
  top-level run + export functions). Not part of #189.
- Docs under `docs/superpowers/plans/` and `plans/` reference the old `.js`
  path historically; leave them as-is (historical records).
