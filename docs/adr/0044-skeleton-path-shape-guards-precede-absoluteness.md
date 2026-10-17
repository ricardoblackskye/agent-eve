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

| input                            | `win32.isAbsolute` | `posix.isAbsolute` | shape guard rejects |
|----------------------------------|--------------------|--------------------|---------------------|
| backslash UNC `\\server\share\x` | true               | false              | yes                 |
| drive-absolute `C:\foo`          | true               | false              | yes                 |
| forward UNC `//server/share/x`   | true               | true               | yes                 |
| drive-relative `C:foo`           | false              | false              | yes                 |
| POSIX-absolute `/etc/passwd`     | true               | true               | no                  |

So on Windows a backslash-UNC or drive-absolute path was claimed by the absoluteness check and the shape
guard never ran. The path was still refused — but the caller and the logs were told *"must be relative to the
workspace"* where Linux said *"looks like a UNC path"* or *"looks like a Windows drive path"*. Both refusals
are correct; the message is the diagnosis, and which guard fired was not stable information.

This was found through measurement rather than inspection. The existing test asserts only
`rejects.toThrow(SkeletonMapError)` — the type, never the reason — so it was green on both platforms while
the reason differed. Diffing the CI coverage artifact against a local run showed `developer-agent.ts` was
the **only** file whose covered lines differed (199 in CI, 192 locally), and that file was the source of the
divergence between the committed #391 baseline (lines 83.89%) and CI's 83.98%.

Attributing those 7 lines took a LINE-level comparison rather than a file-level one, and the first
attribution written here was wrong. Measured per line, the skeleton-map guard branches account for about one
line: the UNC branch was the only one genuinely unreachable on Windows, because the drive-relative form is
not absolute on either platform and so already reached the guard. The larger part is a second, independent
divergence in `createWorkspaceTools`' symlink containment, which Windows never reaches at all — filed
separately as #396. The decision below is unaffected: the guard ordering was wrong on its own terms, independently of how
much of the coverage gap it explains.

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
- The skeleton-map guards are now platform-independent, but `developer-agent.ts` as a whole is **not**:
  the divergence in `createWorkspaceTools`' symlink containment remains (#396). So this change does not by
  itself make one recorded coverage baseline correct for both platforms, and re-recording that floor (#395)
  stays blocked until it does. That re-record is deliberately a separate change, because doing it here would
  mask the delta this decision removes.
- The stable reason is observable, so the next divergence of this kind shows up as a failing assertion rather
  than as a coverage difference nobody reads.
- `plan-validator.ts` tests the same shapes in a single combined condition, so it never had this hazard and
  needs no change. `architect-agent.ts:sanitizeRelativePath` performs similar shape checks and was left
  alone: this record explains the rule, and applying it there is a separate decision.
