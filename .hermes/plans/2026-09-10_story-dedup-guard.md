# Plan: Prevent duplicate user-story issues (dedup guard on the trigger)

- **Date:** 2026-09-10
- **Branch:** `fix/story-dedup-guard`
- **Issue:** follow-up to #61 (no dedicated issue number yet)

## Goal

Prevent the user-story pipeline from creating a **second** `[Story]` issue for a
source issue that already had one generated. Today, re-adding the `needs-story`
label (or a duplicate/racing label event, or a re-edit that still matches the
`@eve-agent` mention) re-runs the whole pipeline and mints a duplicate story.

## Root cause (verified)

`agent/lib/story-trigger.ts` → `isStoryTrigger()` decides whether a GitHub
`issues` event fires story generation. Its `labeled` branch returns `true`
immediately when the incoming label is `needs-story` (case-insensitive), and the
mention path returns `true` whenever the body/labels match `@eve-agent`. Neither
branch consults the issue's *existing* labels.

The #61 finalization marks a completed story by adding the completion label
`user-story-added` (`DONE_LABEL` in `agent/lib/story-labels.ts`) and removing
`needs-story`. So after a successful run the source issue carries
`user-story-added`. But nothing checks that label at trigger time — so a later
`needs-story` label event fires again and a duplicate story is created.

Verified by reading `isStoryTrigger` (no completion-label check) and the
existing `tests/story-trigger.test.ts` (its "no re-trigger" test only asserts
that adding `user-story-added` *alone* is not a trigger — it does not cover
re-adding `needs-story` to an already-finalized issue).

## Intended fix

Add a guard to `isStoryTrigger`: if the issue's current labels already include
`DONE_LABEL` (`user-story-added`), return `false` before any other trigger logic
runs. This uses the full label list already present in the webhook payload
(`issue.labels`) — **no extra API call** — and covers both the label path and
the mention path.

Import `DONE_LABEL` from `agent/lib/story-labels.ts` (now on `main` post-#61) so
the guard checks the exact string that finalization writes — single source of
truth, no drift. The guard is placed after the `closed`/`deleted` short-circuit
and before the `labeled`/mention branching.

## Tasks (TDD, vertical slices)

1. **RED** — `tests/story-trigger.test.ts`: a `labeled` event adding
   `needs-story` to an issue whose labels already contain `user-story-added`
   returns `false` (the current gap — today it returns `true`).
2. **GREEN** — import `DONE_LABEL`, add `hasDoneLabel(payload)`, and short-circuit
   `isStoryTrigger` when it is true. Re-run the test (and full suite).
3. **RED** — regression: a mention-based trigger (`opened`/`edited` with
   `@eve-agent` in the body) on an issue already carrying `user-story-added`
   also returns `false` (the guard must cover the mention path too).
4. **GREEN** — the guard already covers this (it runs before mention branching);
   confirm with the test.
5. **Verify** — full suite, `tsc --noEmit`, cspell on changed files all green.

## Files likely to change

- `agent/lib/story-trigger.ts` — add `DONE_LABEL` import + `hasDoneLabel` + guard.
- `tests/story-trigger.test.ts` — two new tests (label path + mention path).

## Validation

- `npx vitest run` → full suite green (baseline 138 tests, +2 new).
- `npx tsc --noEmit` clean; `npx -y cspell@8 --config .cspell.json <changed>` clean.
- Live (manual, post-merge): after a story is generated (source issue has
  `user-story-added`), re-adding `needs-story` produces **no** new `[Story]`
  issue and no duplicate child-link comment.

## Risks / open questions

- The guard keys off `user-story-added`. If finalization partially fails and a
  child issue exists but the completion label was never applied, the guard will
  not catch it. A stronger "search for an existing linked child issue" guard
  (Option B) would cover that and is noted as a possible future follow-up.
- Intentional regeneration now requires removing `user-story-added` before
  re-adding `needs-story` — an explicit, documented workflow (not a silent loss).
- No new env vars; no credential/scope changes.
