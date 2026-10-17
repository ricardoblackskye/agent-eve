# 0044 — Skeleton path shape guards precede the absoluteness check

- **Date:** 2026-10-17
- **Status:** Accepted

## Context

`applySkeletalMap` validates each entry's path with two checks, and it ran them as sequential statements
with the absoluteness test first:

```ts
if (isAbsolute(relPath)) throw new SkeletonMapError("... must be relative to the workspace.");
assertSafeRelativePath(relPath);
```

`path.isAbsolute` is platform-specific, and the two shapes `assertSafeRelativePath` exists to reject are
exactly the shapes where the platforms disagree. Measured with Node 24:

| input | `win32.isAbsolute` | `posix.isAbsolute` | shape guard rejects |
| --- | --- | --- | --- |
| backslash UNC `\\server\share\x` | true | false | yes |
| drive-absolute `C:\foo` | true | false | yes |
| forward UNC `//server/share/x` | true | true | yes |
| drive-relative `C:foo` | false | false | yes |
| POSIX-absolute `/etc/passwd` | true | true | no |

So on Windows a backslash-UNC or drive-absolute path was claimed by the absoluteness check and the shape
guard never ran. The path was still refused — but the caller and the logs were told *"must be relative to the
workspace"* where Linux said *"looks like a UNC path"* or *"looks like a Windows drive path"*. Both refusals
are correct; the message is the diagnosis, and which guard fired was not stable information.

This was found through measurement rather than inspection. The existing test asserts only
`rejects.toThrow(SkeletonMapError)` — the type, never the reason — so it was green on both platforms while
the reason differed. Diffing every file of the CI coverage artifact against a local run showed
`developer-agent.ts` was the **only** file that differed (199 covered lines in CI, 192 locally): the
drive/UNC rejection branches are reachable on Linux and unreachable on Windows. Those 7 lines were the
entire gap between the committed #391 baseline (lines 83.89%) and what CI measures (83.98%), which meant no
single recorded coverage floor could be correct for both platforms.

## Decision

- **The shape guards run first**, and the absoluteness check runs after. Both still run, so the
  accept/reject DECISION is unchanged: nothing refused before is accepted now, and a POSIX-absolute path
  still reports the absoluteness reason. Only which reason is reported changes — from platform-dependent to
  platform-independent.
- **The rejection reason is part of the contract.** A caller, a log reader or a test must be able to rely on
  which guard fired. An assertion of the error TYPE is satisfied by either guard and therefore does not pin
  the behaviour; reason assertions are required wherever a guard could be reached by a second route.
- **An ordering test must use an input that is absolute on BOTH platforms AND shape-rejected.** Only the
  forward-slash UNC form `//server/share/x` qualifies (win32 true, posix true). The backslash and
  drive-absolute forms cannot serve as the guard precisely because `isAbsolute` diverges for them — that
  divergence is the defect — so a suite relying on them would be green in Linux CI while the ordering was
  still wrong.
- The ordering rule is documented on `assertSafeRelativePath` itself, so it is read at the point of change
  rather than rediscovered through a coverage diff.

## Consequences

- Windows gains the precise reason for all three shapes; Linux keeps the reason it already gave. The
  divergence is removed rather than inverted.
- `developer-agent.ts` covered lines are now platform-independent, so one recorded coverage baseline is
  correct on both platforms. Re-recording that floor is deliberately a separate change (#395), because doing
  it in the same pull request would mask the very delta this decision removes.
- The stable reason is observable, so the next divergence of this kind shows up as a failing assertion rather
  than as a coverage difference nobody reads.
- `plan-validator.ts` tests the same shapes in a single combined condition, so it never had this hazard and
  needs no change. `architect-agent.ts:sanitizeRelativePath` performs similar shape checks and was left
  alone: this record explains the rule, and applying it there is a separate decision.
