# #396 — Exercise the workspace symlink-escape guard on Windows

## Goal

Make the target-is-a-symlink escape guard in `createWorkspaceTools` actually run on Windows, and stop the test
that covers it from reporting PASS while asserting nothing.

This is a **test-adequacy defect, not a production bug**: the guard behaves correctly on this host (verified
below). What is broken is the evidence — the guard is untested on Windows, and the suite says otherwise.

## Root cause (reproduced on this host, win32)

The guard is only reachable when the TARGET path itself is a symlink:

```ts
const targetStat = await lstat(target).catch(() => null);
if (targetStat?.isSymbolicLink()) {
  const realTarget = await realpath(target).catch(() => null);
  if (realTarget) {
    const symRel = relative(realRoot, realTarget);
    ...
```

The covering test (`tests/dark-factory/developer-agent-tools.test.ts`, ~line 126) builds that condition with a
**file** symlink and swallows the failure:

```ts
try {
  await symlink(outsideFile, join(tempDir, "symlink-escape.txt"));
  await expect(tools.readFile("symlink-escape.txt")).rejects.toThrow(/symlink/i);
  await expect(tools.writeFile("symlink-escape.txt", "overwrite")).rejects.toThrow(/symlink/i);
} catch (err: any) {
  // the permission-denied code is swallowed here, so the test still PASSES
  if (err.code !== PERMISSION_DENIED) throw err;
}
```

`PERMISSION_DENIED` stands in for the error code that test swallows, reproduced below. Measured on this machine:

| probe                                  | result                                                        |
|----------------------------------------|---------------------------------------------------------------|
| `symlink(fileTarget, link)`            | **FAILS with a permission error** (needs a Windows privilege) |
| `symlink(dirTarget, link, "junction")` | OK, no elevation                                              |
| `lstat(junction).isSymbolicLink()`     | **true**                                                      |
| guard when the link is absent          | never runs — `lstat` returns null                             |

So on Windows the link is never created, the assertions never execute, and the test passes vacuously. That is
also why the guard's lines report 0 local coverage while CI covers them — the difference #395 is blocked on.

The same missing-evidence problem shows in the assertions: `/symlink/i` is satisfied by **either** symlink
guard (the target check or the ancestor check), so even on Linux the test does not pin which one fired.

**No test anywhere asserts either symlink-traversal message.** A repository-wide search finds both strings only
in the production file, so the guard's reason text is entirely unpinned.

## The route that works on both platforms (verified)

A directory junction is a symlink as far as `lstat` is concerned, needs no elevation, and its NAME is
arbitrary — so it can carry an extension the allow-list accepts. The extension check runs before the symlink
check, which is why the name matters: a junction called `escape` is refused for its extension and never reaches
the guard.

Measured, win32, no elevation:

| input                                                  | outcome                                                                          |
|--------------------------------------------------------|----------------------------------------------------------------------------------|
| `writeFile("escape.ts")`, junction → outside dir       | refused: *"is a symlink resolving outside workspace"* — **target block reached** |
| `writeFile("escape.md")`, junction → outside dir       | refused: same reason                                                             |
| `writeFile("escape/evil.txt")`, junction → outside dir | refused by the **ancestor** block                                                |
| `writeFile("escape")`                                  | refused earlier: disallowed extension                                            |

So the guard is exercisable on both platforms with `process.platform === "win32" ? "junction" : "dir"` — the
same idiom `state-path-hardening.test.ts` already uses, which is evidence the pattern is established in this
repository.

## Intended fix

Test-only, unless TDD uncovers a production defect:

1. A new case that builds the escape route **without swallowing any error** and asserts the TARGET-symlink
   reason specifically. This is the RED: on Windows it fails today at link creation because the permission error is not swallowed,
   which is exactly the defect being fixed.
2. The route then uses a junction named with a permitted extension, so the case runs on both platforms and the
   guard is exercised on Windows for the first time.
3. The existing test's swallow of the permission error becomes a **visible skip** (`ctx.skip()`), matching
   `state-path-hardening.test.ts:47`. A skip is honest; a swallowed error that still reports PASS is not.
4. Assertion strength: replace `/symlink/i` with the specific reason, so the ancestor guard can no longer
   satisfy an assertion about the target guard.

## Tasks (TDD)

### Task 1 — RED then GREEN: the target-symlink guard, exercised on both platforms

- RED: assert the specific reason (`/is a symlink resolving outside workspace/`) for a path that IS the
  escape link, creating the link without a swallow. Fails on Windows today at creation (a permission error).
- GREEN: create the link as a directory junction named with a permitted extension. The case passes on both
  platforms and the target block executes on Windows.

### Task 2 — RED then GREEN: the ancestor guard keeps its own reason

- RED: assert the ancestor message (`/escapes workspace via directory symlink/`) for a write THROUGH the link
  (`escape.ts/evil.txt`). This pins that the two guards are distinguished rather than both matched by
  `/symlink/i`.
- GREEN: already satisfied by the existing guard; the value is that the assertion now says which guard must
  fire. Verify it fails if the message is swapped, so it is not a rename of the weak assertion.

### Task 3 — stop the existing test passing vacuously

- Convert that swallow to `ctx.skip()`, so a platform that cannot create the link reports a SKIP rather
  than a PASS.
- Keep the file-symlink attempt (it is the strongest route where privileges exist) but make its failure
  visible.

### Task 4 — ADR and docs

- ADR **0045**: escape routes are exercised with a directory junction named with a permitted extension,
  because a file symlink needs a Windows privilege; and a harness that swallows a setup error must skip
  visibly rather than pass. Index it in `docs/adr/README.md`.
- Note: no module is added, so `docs/pages/dark-factory-modules.md` is unaffected — confirm the doc-drift
  guard agrees.

### Task 5 — measure the consequence

- Re-run coverage: the target block's lines must move from uncovered to covered locally, and
  `developer-agent.ts` should then report the same covered lines as CI.
- This is the precondition #395 has been waiting on. Report the numbers; the baseline re-record itself stays
  in #395.

## Files likely to change

| file                                                     | change                                                   |
|----------------------------------------------------------|----------------------------------------------------------|
| `tests/dark-factory/developer-agent-tools.test.ts`       | junction route, specific reason assertions, visible skip |
| `docs/adr/0045-workspace-escape-routes-use-junctions.md` | new                                                      |
| `docs/adr/README.md`                                     | index row                                                |

Production code changes only if Task 1 or 2 exposes a real defect.

## Validation

- `npx vitest run tests/dark-factory/developer-agent-tools.test.ts` — the new cases pass, the RED observed first.
- The specific-reason assertions fail if the guard is disabled, so they are not decorative.
- `npx tsc --noEmit --incremental false`, the full suite, and the root guards.
- Local lint gate on every changed file before any push.
- Coverage: the target block covered locally; `developer-agent.ts` matching CI.

## Risks and open questions

1. **No production change expected.** If TDD shows the target guard is wrong for junctions (for example if it
   resolves the junction to the outside directory and reports the wrong reason), that becomes a real fix in
   this same change - the plan does not prejudge it.
2. **Developer Mode is not required.** The junction route needs no privilege, so no user machine setting is
   needed. If it turns out a file symlink is still required for some case, that would be an out-of-code-scope
   ask - to be surfaced with exact steps, not attempted.
3. **A skip is still a gap.** Making the file-symlink path skip visibly does not itself cover anything; the
   junction route is what closes the gap. If a reviewer wants the file-symlink route covered too, that needs
   Developer Mode on the runner or an elevated CI runner, which is a separate decision.
4. **Coverage as the RED anchor.** For Task 1 the failing behaviour is a harness that cannot construct its
   fixture on Windows, so the RED is that failure plus the coverage number, not a wrong production result.
   Stated explicitly so nobody later mistakes this for a behaviour change.
