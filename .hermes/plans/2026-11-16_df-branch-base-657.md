# Plan: a run's branch must be cut from current main, not the image's baked checkout (#657)

**Issue:** #657
**Branch:** `fix/df-branch-base-657`
**Base:** `origin/main` @ `f2df9a5`

## Goal

A Dark Factory run must branch from the target's CURRENT `origin/<default>`, so its PR is a change
against today's `main` rather than a change against whatever the sandbox image was built with.

## Evidence (measured, not inferred)

A real local e2e run (WebFeedPOC#204 -> PR ricardoblackskye/WebFeedPOC#205) produced a CORRECT change and
a STALE base. Two independent readings agree on the base commit:

GitHub's own compare of the run's branch:

```text
compare main...feat/dark-factory-204
  status=diverged  ahead_by=1  behind_by=3
  merge_base = 15f22ed  (2026-09-08)
  main tip   = 9b9e47d  (2026-11-02)
```

The sandbox image that ran it:

```text
$ docker run --rm --entrypoint sh df-sandbox-webfeedpoc:4 -c "cd /workspace && git rev-parse HEAD"
15f22ed03dbd515cf6b7dcc02e96fc8e77359920
```

The merge base IS the image's baked `/workspace` (image built 2026-10-16).

## Root cause

`ensureSandboxRepo` (`agent/lib/dark-factory/git-push.ts:122-142`) treats "the image already carries the
repo" as ready:

```ts
// The documented image already carries the repo; only clone when it does not.
if (inside.exitCode === 0) return { ok: true, cloned: false };
```

Nothing fetches, and nothing resets to the current default branch. The later
`commitAndPushFromSandbox` runs `git checkout -B <branchName>`, which cuts the branch from HEAD - and
HEAD is the image's baked commit.

This is the DOCUMENTED path, not an edge case: the local-run docs state the requirement as an image that
"ALREADY carries the project (repo + deps)".

## Intended fix

On the "already inside a work tree" path of `ensureSandboxRepo`, bring the checkout to the current
default branch BEFORE returning - so the branch that is cut later starts from today's `main`:

1. capture the base (`rev-parse HEAD`) so it can be reported and compared,
2. `fetch origin --prune` (the vault sidecar supplies the credential; `runGit` already sets
   `GIT_TERMINAL_PROMPT=0`, so this needs no new plumbing and no credential on argv),
3. refresh `refs/remotes/origin/HEAD` from the fetched refs,
4. resolve the default branch from `origin/HEAD` and `reset --hard` to it,
5. return the before/after base so the runner can log it.

Order matters and is the whole point: this runs BEFORE the coding loop writes anything. A reset after the
loop would destroy the developer's work.

It is a fetch plus a hard reset, never a clean: the image's untracked build output (`node_modules`) has to
survive, or every run pays a reinstall.

## Acceptance criteria (from the issue)

- [ ] A run's branch is cut from the target's current `origin/<default>`.
- [ ] The sync runs before the coding loop writes anything.
- [ ] Untracked build output survives the sync.
- [ ] The run log names the base commit before and after.
- [ ] A fetch/sync failure FAILS the run loudly rather than proceeding on a stale tree.
- [ ] No credential on argv; the vault path is reused.

## Tasks (strict TDD)

- **T1 (RED)** - extend `tests/dark-factory/git-push.test.ts` (`#354 ensureSandboxRepo`): with the fake
  `runGit` recorder, assert that when the repo is ALREADY inside a work tree the call fetches and resets
  to `origin/HEAD` before returning, and that a failing fetch returns `ok: false` naming the reason.
  RED: today the call records no fetch and no reset, because it returns early.
- **T2 (GREEN)** - implement the sync in `ensureSandboxRepo`; widen `SandboxRepoResult` with the
  before/after base.
- **T3** - the runner logs the base (`scripts/dark-factory-runner.ts`, at the existing
  `ensureSandboxRepo` call site).
- **T4** - keep the existing `#354` tests' INTENT (still no clone when the repo is present) and tighten -
  never bump - any assertion that the change legitimately moves.
- **T5** - gates: `npm run eve:build`, `npx tsc --noEmit --incremental false`, the full suite, and
  cspell/markdownlint on the changed files.
- **T6** - prove it end to end: re-run a local sandbox run and confirm the branch's merge base is the
  target's current `main` (the same measurement that found the defect).

## Files

- `agent/lib/dark-factory/git-push.ts` (the fix)
- `tests/dark-factory/git-push.test.ts` (the tests)
- `scripts/dark-factory-runner.ts` (log the base)
- possibly `docs/pages/dark-factory-local-runs.md` (the image-with-repo requirement now also implies the
  base is refreshed)

## Risks and open questions

- **A reset is destructive by design.** It is safe only because it runs before the loop. If a future
  caller of `ensureSandboxRepo` moves it after the writes, the developer's work would be discarded - so
  the function's doc comment must state the ordering requirement explicitly.
- **`origin/HEAD` may be stale in an image.** The fix refreshes it from the fetched refs first, and FAILS
  if it still cannot be resolved rather than guessing a branch name.
- **Should the clone path change too?** A fresh `git clone` already lands on the default branch tip, so it
  needs nothing - but the plan asserts that with a test rather than leaving it implicit.
