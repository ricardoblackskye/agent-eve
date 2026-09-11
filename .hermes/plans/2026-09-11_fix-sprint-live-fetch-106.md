# Fix: Inline GraphQL selection — GitHub fragments can't reference `$number`

## Context
PR #107 (`feat/sprint-metrics-106`) is merged. Live testing against `ricardoblackskye` project #3 surfaced a real GraphQL contract bug: GitHub's schema **rejects** a `$number` variable referenced inside a `...BoardFields` fragment with `variableNotUsed` + `cannotSpreadFragment`. The current production code uses the fragment form, so the sprint-report subagent silently fails on a real board.

## Verification
- **Live** (token provided for smoke test) queried `ricardoblackskye #3` → `Agent Eve`, **67 items**, all Status columns parsed, pagination + strict status working.
- Full suite: 176/176 unit + 8 live assertions, 1 skipped (live test gated on `GH_SPRINT_TOKEN`).
- tsc clean, cspell 0, prettier clean, markdown-table-formatter clean.

## Fix (already implemented & tested, needs re-homing to a fix branch)
1. `agent/lib/sprint-projects.ts`: replaced the fragment-spread query (`user(login) { ...BoardFields }`) with **inlined** selections for both `USER_QUERY` and `ORG_QUERY`, so `$login`, `$number`, `$cursor` are all used directly in each root field.
2. Added `resolveOwnerType()` — a single cheap REST `/users/{login}` probe returning `"user" | "org"`, so we pick the correct GraphQL root (`user` vs `organization`) **without** querying both (querying both on a user account returns a hard `NOT_FOUND` that shadows the valid result).
3. Switched the Contents API write in `sprint-delivery.ts` from `html_url` + domain-replace (produced invalid `raw.githubusercontent.com/.../blob/...url`) to the API's native `download_url`.

## Tests
- `tests/sprint-projects.test.ts`: added owner-type probe assertions + org-root query selection + a `fails-fast when owner login does not exist` case.
- `tests/sprint-projects.test.ts`: added a `GH_SPRINT_TOKEN`-gated **live** integration test asserting the real board returns `title: "Agent Eve"` with >0 items (CI stays hermetic without the token).
- Updated `tests/sprint-delivery.test.ts` mock to assert `download_url` is used.

## Branch
`fix/sprint-live-fetch-106` off `origin/main` (current merge-base of the closed #107).
