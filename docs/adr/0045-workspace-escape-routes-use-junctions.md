# 0045 — Workspace escape routes are exercised with directory junctions

- **Date:** 2026-10-17
- **Status:** Accepted

## Context

`createWorkspaceTools` refuses a write whose TARGET path is a symlink resolving outside the workspace. That
guard is reachable only when `lstat(target)` reports a symlink, so a test has to place a symlink exactly at the
target path.

The test that covered it placed a **file** symlink. Creating a file symlink on Windows requires a privilege, so on
that platform the call fails with a permission error — and the test caught that error and carried on:

```ts
} catch (err: any) {
  // If OS environment does not permit non-admin symlink creation, verify graceful bypass
  if (err.code !== PERMISSION_DENIED) throw err;
}
```

The assertions lived inside the same `try`, so they never ran. The test reported **PASS** while asserting nothing,
and the guard had no coverage on Windows at all. That is the same failure shape as a status-only assertion: correct
in appearance, blind to the thing it looks like it protects.

Two related weaknesses sat alongside it. The assertions used a loose matcher satisfied by **either** symlink guard
(the target check or the ancestor check), so they never pinned which one refused. And no test anywhere asserted
either guard's message — a repository-wide search found both strings only in the production file.

## Decision

- **Escape routes are exercised with a DIRECTORY JUNCTION**, created as
  `symlink(target, link, process.platform === "win32" ? "junction" : "dir")`. A junction needs no elevation on
  Windows, yet `lstat` still reports it as a symlink, so the same case builds the same condition on both platforms.
- **The link's NAME must carry a permitted extension.** The extension allow-list is checked before the symlink
  guards, so a junction named `escape` is refused for its name and never reaches them; a junction named `escape.ts`
  does. Without this the route looks like it exercises the guard while proving nothing — which is what the first
  attempt at it did.
- **A harness whose setup can fail must SKIP VISIBLY.** `ctx.skip()` reports that the route was not exercised; a
  caught error that lets the test pass reports the opposite. The skip is placed outside the assertion block so the
  two cannot be confused.
- **Assertions name the guard.** Each symlink guard has its own case matching its own reason, so a change that
  collapses them into one message fails the suite.

## Consequences

- The target-is-a-symlink guard is exercised on both platforms, which closes the platform-dependent coverage
  difference the #391 baseline could not accommodate (#395 depends on that).
- A skip remains a genuine gap rather than a fix. It is the honest report that a route (here, a file symlink)
  needs a privilege, and the junction route is what actually removes the gap for the escape behaviour.
- **A fixture defect can only have a platform-scoped RED.** The failing behaviour here is "the harness cannot build
  its condition on Windows"; file symlinks work on Linux without a privilege, so CI passes before the fix. Stating
  that is the point: a green CI run must not be read as evidence the defect was absent. Where a host-independent
  probe does exist — as with the guard ORDERING in #394 — it should be used instead.
- The privilege requirement stays documented rather than worked around by asking for a machine setting.
