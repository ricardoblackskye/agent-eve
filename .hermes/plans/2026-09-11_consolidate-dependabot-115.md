# Plan: Consolidate Dependabot updates — Issue #115

## Goal
Apply three Dependabot-flagged dependency bumps as a **single atomic change**
on one branch, so the critical `next@16.3.3` RCE patch + `sharp@0.35.4` +
`@playwright/test@1.63.0` are tested, reviewed, and deployed together (not as
three separate PRs #109/#110/#111).

## Source of truth
The three Dependabot PRs (all currently **open**, all targeting `main`):
- #109 `chore(deps): bump sharp from 0.35.3 to 0.35.4` — `package-lock.json` only.
- #110 `chore(deps): bump playwright and @playwright/test` — `package.json` + `package-lock.json` (`@playwright/test` `^1.51.1` → `^1.63.0`).
- #111 `chore(deps): bump next from 16.3.2 to 16.3.3` — `package.json` + `package-lock.json` (`next` `^16.3.2` → `^16.3.3`).

## Target versions (confirmed from the PRs)
| Package | From | To |
|---|---|---|
| `next` | `^16.3.2` | `^16.3.3` |
| `@playwright/test` | `^1.51.1` | `^1.63.0` |
| `sharp` | `0.35.3` (transitive) | `0.35.4` |

## Approach
1. Branch `chore/dependabot-consolidate-115` off `main` HEAD (`6164558`).
2. Run **one** `npm install next@16.3.3 @playwright/test@1.63.0 sharp@0.35.4`
   so npm resolves a single consistent lockfile (cherry-picking 3 separate
   package-lock hunks risks over-constraining transitive deps).
3. Verify:

   ### Acceptance criteria (from #115)
   - [ ] `npm install` exits 0, no unresolved peer-dep warnings.
   - [ ] `npm test` (vitest) passes, no new failures.
   - [ ] All CI checks (MegaLinter, Vercel preview) green.
   - [ ] After merge, security-advisory page shows **zero open alerts** for
         next, sharp, `@playwright/test`.
   (Note: `sharp` has no top-level package.json entry — it's `@img/sharp-*`;
    bumping it via `npm install sharp@0.35.4` rewrites only the lockfile,
    matching PR #109 exactly.)

## Risks / decisions
- `playwright` core package is a peer of `@playwright/test`; bumping only
  `@playwright/test` per PR #110 is what Dependabot proposed — we mirror it.
- Node runtime here is 22 (Vercel preview may need 24 for `next@16.3.3`'s
  peer range) — watch CI for `engine` errors and report, don't workaround.
- No source code changes expected (deps-only); PR review = lockfile diff only.

## Branch naming note
Filename/branch use `115` (no `#`) to avoid GitHub web-UI path truncation.
