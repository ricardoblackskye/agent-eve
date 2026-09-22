# Plan — #184: Fire the Release Manager only when a PR is merged

**Issue:** [#184](https://github.com/ricardoblackskye/agent-eve/issues/184) — "Eve is called on every PR action"
**Branch:** `fix/pr-release-notes-merged-only-184`
**Type:** bug fix (over-broad trigger)

## Goal

Stop the GitHub webhook's `pull_request` branch from invoking Eve on **every** PR
action. It must call the Release Manager (generate release notes) **only when a
pull request is merged** — `action === "closed" && merged === true`. Every other
PR event must be acknowledged with HTTP 200 and make **no** Eve call.

## Root cause (verified)

- `app/api/github/webhook/route.ts:221` — `if (event === "pull_request")` has **no
  action gate**. It builds the release-notes message (`:246`) and POSTs to
  `/eve/v1/session` (`:309`) for _every_ PR action (`opened`, `synchronize`,
  `reopened`, `labeled`, `closed`, …). `action` is used only to label the message.
- On an Eve failure it returns **502** (`:337–345`) — the intentional bug-#39
  behaviour that surfaces the failure instead of masking it. So while Eve is
  unavailable (e.g. the current Hobby Workflow-limit / 401 cascade), **every** PR
  webhook delivery 502s — and GitHub retries each non-2xx, amplifying the noise.
- Contrast: the `issues` branch (`:365`) gates on pure detectors
  (`isSprintReportTrigger`, `decideDarkFactoryTrigger`, `isStoryTrigger`) and
  returns 200 `"…is not a story trigger"` for non-triggering actions, making no
  Eve call. That asymmetry is exactly what the issue reports.

## Intended fix

- Add a pure, testable predicate `isReleaseNotesTrigger({ action, merged })` in a
  new `agent/lib/release-trigger.ts`, mirroring `agent/lib/story-trigger.ts`. It
  returns `true` **only** when `action === "closed" && merged === true`.
- Gate the `pull_request` branch in the webhook: when the predicate is false,
  return 200 `{ ok: true, message: "PR #N <action> received but is not a release
trigger" }` **before** building the message or calling Eve (no fetch, no 502).
- Leave the triggering path unchanged: build the message, call Eve, and return
  502 with `ok:false` on failure (bug-#39 semantics preserved).

Why `merged`, not just `closed`: a `pull_request.closed` webhook fires for both
merged and unmerged closes; only a merge means the change landed on the base
branch, which is what release notes describe. An unmerged close must not spawn a
session.

## Tasks (strict TDD)

1. **RED — unit** `tests/release-trigger.test.ts` (new):
   - `{ action: "closed", merged: true }` → `true`
   - `{ action: "closed", merged: false }` → `false` (closed without merge)
   - `{ action: "closed" }` (merged absent) → `false` (fail-safe: absent ≠ merged)
   - `{ action: "opened", merged: true }` → `false` (merged flag only meaningful on close)
   - `{ action: "synchronize" }`, `"reopened"`, `"labeled"`, `"edited"` → `false`
2. **GREEN — implement** `agent/lib/release-trigger.ts` `isReleaseNotesTrigger`.
3. **RED/GREEN — route** extend `tests/webhook-handler.test.ts` (the existing
   pattern mocks only `next/server` + `fetch`, which works):
   - non-merged PR (`{ action: "opened" }` and `{ action: "closed", merged: false }`)
     → status 200, `ok: true`, and the `fetch` spy is **not called** (proves no Eve call)
   - merged PR (`{ action: "closed", merged: true }`) → still calls Eve; 502 on
     failure and `accepted` on success (preserves existing behaviour)
4. **REFACTOR** — wire the predicate into the route; keep the diff minimal; no
   behaviour change on the merged path.

## Files likely to change

- `agent/lib/release-trigger.ts` (new) — pure predicate
- `app/api/github/webhook/route.ts` — gate the `pull_request` branch
- `tests/release-trigger.test.ts` (new)
- `tests/webhook-handler.test.ts` (extend)
- `README.md` / `ARCHITECTURE.md` — document that release notes trigger only on a
  merged PR (repo convention: an undocumented behaviour is an incomplete deliverable)

## Validation

- `npx vitest run` — full suite green (existing + new).
- `npx tsc --noEmit` — clean.
- Local lint gate before push: `npx -y cspell@9 --config .cspell.json <changed files>`
  plus marked-up-doc hygiene on the changed docs (fenced-code language, tables).
- Behavioural reasoning: a merged PR emits `pull_request` `closed` with
  `merged: true`, so the release-notes path is preserved end to end.

## Risks / open questions

- **Definition of "merged":** GitHub sets `pull_request.merged = true` on a
  `closed` event for a merged PR. An unmerged close (`merged: false`) will no
  longer trigger release notes — intended, and the single behavioural narrowing.
- **Existing tests:** `tests/webhook-handler.test.ts` uses `VALID_PR_BODY`
  (`action: "closed", merged: true`) → still a trigger, so existing assertions
  remain valid and unchanged.
- **Scope:** only the `pull_request` branch changes; the `issues`,
  sprint-report, dark-factory and story branches are untouched.
- **Out of scope (separate work):** the underlying Eve outage (Hobby Workflow
  usage limit + the `resolveApiOrigin`/`VERCEL_URL` protection concern), and the
  webhook's `[object Object]` error-detail logging. #184 addresses only the
  over-broad trigger; the logging fix belongs in its own branch.
