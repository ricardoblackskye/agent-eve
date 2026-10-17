# #394 — Reject unsafe skeleton paths with a platform-independent reason

## Goal

Make `assertSafeRelativePath` run **before** the `isAbsolute` check in `applySkeletalMap`, so the *stated reason* a
bad skeleton path is refused is identical on Windows and Linux.

The accept/reject **decision does not change**: every path refused today is still refused, by the same guard, with
the same `SkeletonMapError` type. Only which guard reports first changes — that is, only the message.

## Root cause (verified, not inferred)

`agent/lib/dark-factory/developer-agent.ts` runs the two checks as sequential statements, absoluteness first:

```ts
for (const [relPath, content] of Object.entries(map)) {
  if (isAbsolute(relPath)) {
    throw new SkeletonMapError(
      `Skeleton path '${relPath}' must be relative to the workspace.`,
    );
  }
  assertSafeRelativePath(relPath);
```

`path.isAbsolute` is platform-specific, so on Windows two of the shapes `assertSafeRelativePath` exists to catch never
reach it — `isAbsolute` claims them first. Measured with Node 24 on this host:

| input                              | `win32.isAbsolute` | `posix.isAbsolute` | shape guard rejects | outcome                        |
|------------------------------------|--------------------|--------------------|---------------------|--------------------------------|
| `\\server\share\x` (backslash UNC) | true               | false              | yes                 | reason **differs** by platform |
| `//server/share/x` (forward UNC)   | true               | true               | yes                 | reason differs (see below)     |
| `C:\foo` (drive-absolute)          | true               | false              | yes                 | reason **differs** by platform |
| `C:foo` (drive-relative)           | false              | false              | yes                 | same reason on both            |
| `/etc/passwd` (POSIX-absolute)     | true               | true               | no                  | same reason on both            |

So the same bad input is refused on Windows as *"must be relative to the workspace"* and on Linux as *"looks like a
UNC path"* or *"looks like a Windows drive path"*. Both refusals are correct; the message is the diagnosis, and a
caller or a log reader cannot rely on which guard fired.

### The measurement consequence

This is not only cosmetic. Diffing every file of the CI `coverage-report` artifact against a local run on the same
commit: **all 194 files are identical except one.**

| file                                        | local covered lines | CI covered lines |
|---------------------------------------------|---------------------|------------------|
| `agent/lib/dark-factory/developer-agent.ts` | 192                 | **199**          |
| every other file (193)                      | —                   | identical        |

Those 7 lines are the drive/UNC rejection branches plus the `reject` closure body — reachable on Linux, short-circuited
on Windows. That single file is the **entire** difference between the committed #391 baseline (lines 83.89%) and what
CI measures (83.98%).

Which means the ratchet in #391 cannot have one correct baseline while this divergence exists: measured on Windows the
gate prints a false *"Coverage improved. Record the new floor"* on every CI run; measured on CI it would fail on every
local run (6803 vs 6810 is 0.086pp, past the 0.05pp tolerance). Fixing the ordering makes the two platforms agree, so
a single recorded floor becomes correct.

## Why the existing test cannot catch this

`tests/dark-factory/developer-agent.test.ts:327` ("rejects tricky traversal and platform-specific path forms") loops
over the bad shapes including `\\server\share\evil.ts` and asserts only:

```ts
).rejects.toThrow(SkeletonMapError);
```

It asserts the **type**, never the **reason**. It is therefore satisfied by either guard, on either platform — it has
been green the whole time while the reason has differed. This is the same class as a status-only assertion: correct in
appearance, blind to the defect it looks like it covers.

## The testability insight this plan turns on

To prove the *order* in Linux CI, the probe input must be absolute on **both** platforms **and** shape-rejected.
Per the table above, exactly one form qualifies: the **forward-slash UNC** `//server/share/x`.

- Pre-fix, `isAbsolute` reports true on win32 *and* posix, so it throws first on both → *"must be relative to the
  workspace"*.
- Post-fix, the shape guard runs first on both → *"looks like a UNC path"*.

That gives a RED that fails in CI as well as locally. The backslash UNC and drive-absolute forms **cannot** serve as
ordering probes precisely because `isAbsolute` diverges for them — and that divergence is the bug. They are still
worth asserting, for reason stability, but on Linux they already take the shape path, so they cannot fail in CI.

## Intended fix

Swap the order of the two checks. Nothing else:

```ts
assertSafeRelativePath(relPath);          // shape reasons first: identical on every platform
if (isAbsolute(relPath)) {                // then absoluteness, which still catches /etc/passwd
  throw new SkeletonMapError(
    `Skeleton path '${relPath}' must be relative to the workspace.`,
  );
}
```

A POSIX-absolute path such as `/etc/passwd` is unchanged: the shape guard does not reject it (no drive prefix, does
not start with `//` or `\\`), so it still reports *"must be relative to the workspace"* on both platforms.

## Tasks (TDD)

### Task 1 — RED then GREEN: the ordering probe

- RED: assert that `//server/share/evil.ts` is rejected with the **shape** reason, not the absoluteness reason
  (`/looks like a UNC path/`). Fails pre-fix on both platforms because `isAbsolute` wins.
- GREEN: reorder the two checks. Confirm the case flips and the traversal cases stay green.

### Task 2 — RED then GREEN: reason stability for the platform-divergent forms

- RED: assert the shape reason for the backslash UNC and the drive-absolute forms.
- GREEN: satisfied by the Task 1 reorder; these cases then report the same reason on both platforms.
- State plainly in a comment that these two cases cannot fail in Linux CI (that is what Task 1's probe is for), so a
  future reader does not mistake them for the ordering guard.

### Task 3 — control cases: the contract is otherwise unchanged

- Control A: `/etc/passwd` still reports *"must be relative to the workspace"* (the reorder must not swallow it).
- Control B: a valid nested path still writes, so the guards cannot pass by refusing everything.
- Control C: a null-byte path still reports its own reason.
- These are the cases that stop a "refuse everything" implementation from passing the suite.

### Task 4 — ADR and docs

- ADR **0044**: why the shape guards precede absoluteness (platform-independent diagnosis), with the `isAbsolute`
  semantics table and the rule that a host-independent ordering test uses the forward-slash UNC form.
- Index the ADR in `docs/adr/README.md`.
- No new module, so `docs/pages/dark-factory-modules.md` is unaffected — verify the `doc-drift-guards` test agrees.

### Task 5 — measure the consequence

- Re-run coverage and confirm the skeleton-map GUARD region now matches CI - in particular that the UNC rejection
  branch is reached on Windows. Measured: it is, so this half of the expectation holds.
- **Corrected during implementation.** The original expectation was that `developer-agent.ts` would report identical
  covered lines on both platforms. It does not: 193 locally against 199 in CI. A file-level diff had made the guards
  look like the whole cause; measured per line, they account for about one line, and the larger part is a SECOND
  divergence in `createWorkspaceTools`' symlink containment that Windows never reaches. Filed as #396, and ADR 0044
  now carries the corrected attribution. #395 therefore stays blocked.
- **OUT OF SCOPE here:** committing a new `coverage-baseline.json`. This task *measures* the consequence; recording the
  new floor is #395, deliberately separate so it cannot mask the delta this change removes.

## Files likely to change

| file                                                               | change                                           |
|--------------------------------------------------------------------|--------------------------------------------------|
| `agent/lib/dark-factory/developer-agent.ts`                        | swap the two checks; no signature or type change |
| `tests/dark-factory/developer-agent.test.ts`                       | ordering probe, reason assertions, control cases |
| `docs/adr/0044-skeleton-path-shape-guards-precede-absoluteness.md` | new                                              |
| `docs/adr/README.md`                                               | index row                                        |

## Validation

- `npx vitest run tests/dark-factory/developer-agent.test.ts` — green, with the RED observed first.
- `npx tsc --noEmit --incremental false` — clean.
- Full suite + the root guards (`doc-drift-guards`, `adr-integrity`, `env-example-coverage`).
- Local lint gate on every changed file before any push: markdownlint, markdown-table-formatter (pinned), cspell
  (reword, never teach the dictionary).
- Coverage: `developer-agent.ts` identical between platforms per the artifact comparison.

## Risks and open questions

1. **Message change on Windows.** `C:\foo` and `\\server\...` will report the shape reason instead of the absoluteness
   reason. Verified safe: each of the three message strings appears exactly once in the repository, at its definition,
   and no test or caller asserts either message for those inputs.
2. **Should the #391 baseline be re-recorded here or separately?** **CONFIRMED: separately** (user, 2026-10-17).
   Re-recording is its own committed decision, and doing it in this pull request would mask the very platform delta
   this change fixes. It also carries an ordering constraint — it can only be done once this change is on `main`, and
   the measurement must be taken with CI's environment. Tracked as **#395** so it is not lost.
3. **Similar shape checks elsewhere.** `architect-agent.ts:sanitizeRelativePath` and `plan-validator.ts:146` also test
   drive/UNC forms. `plan-validator.ts` already uses a single combined condition, so it has no ordering hazard. Both are
   **out of scope**; noted so the inconsistency is not rediscovered as a surprise.
4. **Out-of-code-scope:** none. No repository setting or environment change is required.
