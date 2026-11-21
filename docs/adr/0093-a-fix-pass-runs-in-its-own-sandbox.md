# 0093 - A fix pass runs in its own sandbox

Date: 2026-11-20

Status: Accepted

## Context

A run holds one sandbox at a time, and the phase that creates it releases it: `runCodingPhase`
creates the workspace tools, runs the phase, and force-disposes the sandbox in a `finally`, so
it is released on success, on a thrown error and on an early return. The commit and the
definition of done both sit **outside** that call, which means the DoD never runs inside the
coding sandbox.

When the fix cycle was designed, the question was whether it could reuse that sandbox. It
cannot, in either direction:

- On the normal path the sandbox is **already disposed** by the time the DoD runs. It was not
  reaped — `reapSandboxesByRun` runs at the *start* of a run and only reclaims a sandbox a
  create-time client timeout left behind. The normal release is the phase's own `finally`.
- On the **verify-only re-entry** — a run resumed because it was waiting on checks that may
  since have settled — no sandbox is ever created at all. That path re-reads the checks and
  returns before the coding phase is reached.

So a fix pass finds no workspace on either path, and it needs one: authoring and pushing
requires a checkout of the repository on the pull request's own branch.

## Decision

A fix pass opens **its own sandbox**, under the **same run id** as the run it belongs to.

It is created with the run id for one reason: `reapSandboxesByRun` keys on the run id, so a
fix sandbox under any other id would be invisible to the reaper and become a leak with no
safety net.

The pass releases it on every path — the early returns and the throws included — with its own
guard, so a failing close cannot mask the pass's real outcome.

The checkout is prepared **before** the branch is committed to. `commitAndPushFromSandbox`
runs `git checkout -B <branch>`, which resets that branch to the current HEAD; a pass that
checked out the default tip and then pushed would rewrite the pull request's branch to `main`
and destroy the work it was supposed to be fixing.

## Consequences

A fix pass costs a sandbox lifecycle, which is the honest price of changing code after the
DoD has begun. The phases that do not change code — the verify-only re-entry among them —
still pay nothing, because they still open nothing.

Sandbox counts per run are no longer one. Anything that reasons about a run's sandbox must
reason about the phase that owns it rather than assuming a single sandbox for the run's
lifetime.
