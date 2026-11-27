# Unblock the local build: resolve the Next.js security nudge for next 16.4.3

**Issue:** #799 · **Branch:** `chore/nextjs-security-upgrade` (off main `3f0232b`)

## Why we are doing this

`npm run build` fails on a developer machine with:

```text
Error [SecurityFatalError]: Your version of Next.js is affected by a known security vulnerability.
```text

Next.js ships an upgrade nudge that becomes **fatal** when the reminder kind is `security`. It is not a warning that can
be carried past — the local build stops, so nobody can build or deploy from a dev machine. The underlying advisory is
real regardless of where the build runs.

**What this does not change:** it does not fix CI, because CI is not broken by this. It does not touch `Production Evals`
(#761 — main is red on that job for an unrelated reason, and fixing it here would be scope creep). And it does not change
how the app behaves; this is a dependency and build-environment change.

## The correction that reshaped this plan

The issue originally claimed the build was blocked everywhere and the deploy route was closed, inferring from green PR
checks that CI never builds. **Both were wrong.** `ci.yml:157` defines an `Eve Build` job that `Evals` depends on, and on
the newest main run it **passes**:

```text
Eve Build            success
  Run npm run build  success        <- with next 16.4.3
```text

So the nudge **fires locally and not on the CI runner**. That difference is now the first task, because if we do not
understand it, a version bump might only change which version the reminder is keyed to.

## What we know, from reading rather than assuming

| fact                          | evidence                                                                                                                                                                    |
|:------------------------------|:----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| installed                     | `next` **16.4.3**; `package.json` declares `^16.4.3`                                                                                                                        |
| published                     | **16.4.6** — a patch bump *inside* the declared range                                                                                                                       |
| the mechanism                 | `next/dist/lib/upgrade/nudge.js` — `assessUpgrade(dir, config, installedVersion = "16.4.3", …)`, a baked `kind: 'security'` reminder, fatal via `stopBefore === 'security'` |
| it is aimed at agent sessions | the nudge is exposed through `nudgeUpgradeForAgent` (`:256`)                                                                                                                |
| CI builds and passes          | `Eve Build` job, `needs: [typecheck]`, `npm run build` success on `3f0232b`                                                                                                 |
| one copy of next in the tree  | `npm ls next` → `next@16.4.3`, single                                                                                                                                       |
| peers are satisfied           | `next@16.4.6` wants `react ^18.2.0 \|\| ^19.0.0`; the repo has `react` / `react-dom` `^19.2.8`                                                                              |
| runtime floor                 | `node >=20.9.0`                                                                                                                                                             |
| nothing else to align         | no `eslint-config-next` and no `@next/*` packages in the manifest                                                                                                           |
| Dependabot state              | **unverified** — API returned 403 for this token's scope                                                                                                                    |

## Task 1 — why does it fire locally but not in CI? (do this first)

The whole plan hinges on the answer, and it is cheap to find out. Ordered by likelihood:

- [ ] **Run the local build with `CI=true`** and see whether the nudge still fires. This is the single most informative
      experiment available and it costs one build. If it stops firing, the trigger is CI-detection and the "fix" is
      environmental, not a version bump.
- [ ] Check whether the nudge is gated on interactivity / a TTY / an agent session (`nudgeUpgradeForAgent` is suggestive),
      and whether it consults the network for advisories (`Could not check Next.js security advisories. Continuing
      without an upgrade assessment.`).
- [ ] Check `next.config.ts` for an upgrade policy setting, and the workflow environment for anything that suppresses it.
- [ ] Record the answer on #799 **before** touching versions. *If we cannot say why CI passes, we cannot say the bump is
      what fixes it.*

**Completion:** a stated, evidenced reason for the difference — or an explicit "still unknown" with what was tried.

## Task 2 — the version decision

Only after Task 1:

- [ ] **If the failure is genuinely version-driven:** `npm install next@16.4.6`, commit `package.json` +
      `package-lock.json`. Stay inside `16.4.x` — `AGENTS.md` warns this is *"not the Next.js you know"* with breaking
      changes against training data, so a minor jump is a separate decision with its own verification.
- [ ] **If Task 1 shows it is environmental:** say so and decide explicitly whether to bump anyway. The advisory is real,
      so bumping is still defensible — but it would be wrong to claim the bump is what unblocked the build.
- [ ] **Do not reach for a suppression flag** without understanding what it suppresses. Silencing a security nudge
      without knowing the advisory is worse than the failing build.

## Task 3 — prove it

- [ ] **The local build exits 0.**
- [ ] **The specific error is gone**, not merely that the build passes: assert `SecurityFatalError` and
      `known security vulnerability` are absent from the output. A build that passes for an unrelated reason would
      otherwise look like a fix.
- [ ] **`npm ls next` reports a single, deduped version.** A second copy in the tree leaves the nudge armed.
- [ ] **Full suite and `npm run coverage:ratchet` exit 0.**
- [ ] **If Task 1 was the `CI=true` experiment, run both ways**: the build must pass locally *and* still pass in CI. A fix
      that only works in one of them is not a fix.
- [ ] **Observe the failure before and its absence after.** *A check you have not seen fail is a check you do not know
      works.*

## Task 4 — the surfaces this version touches

`AGENTS.md` says plainly that Next here differs from what training data knows. So exercise what touches it:

- [ ] `app/chat.tsx` renders and behaves.
- [ ] `app/api/eve/v1/[...slug]/route.ts` responds.
- [ ] The frontend eval passes (`evals/frontend.eval.ts`).

**Note the distinction:** *that* is the **frontend eval**. `Production Evals` is a different job and is failing on main
for unrelated reasons (#761) — do not read one as evidence about the other, and do not fix #761 here.

## What this does not change

- Main's red CI (`Production Evals`, #761) — separate cause, separate issue.
- The license work: #797 (the notice, committed on `chore/license-notice` and un-PR'd) and #798 (the guard, not started).
- Repository visibility — staying public, per the decision on #796.
- Runtime behaviour and application logic.

## Gates

cspell 0 · markdownlint 0 non-MD013 · pinned table formatter last · `tsc --noEmit --incremental false` 0 ·
`npm run coverage:ratchet` exit 0 · full suite against a single `darkfactory_test` (never two suites at once).

## Risks

| risk                                                                               | mitigation                                              |
|:-----------------------------------------------------------------------------------|:--------------------------------------------------------|
| the bump is done without understanding the trigger, so we cannot say what fixed it | Task 1 first, and its answer recorded on #799           |
| the nudge is suppressed rather than satisfied                                      | Task 2 forbids suppression without knowing the advisory |
| a second next copy keeps the nudge armed                                           | `npm ls next` asserted after                            |
| a patch bump breaks the "not the Next.js you know" API surface                     | Task 4's three surfaces, including the frontend eval    |
| fixing #761 by accident and conflating two failures                                | named as out of scope, with the eval distinction stated |
