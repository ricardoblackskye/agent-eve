# Next.js 16.4.0 to 16.4.3: clear the three advisories (#459)

## Goal

Move the locked Next.js outside `>=16.0.0 <=16.4.0` so the two critical and one high advisory against it no longer
apply, and so `npm run build` stops refusing its first invocation with `SecurityFatalError`.

This is one change, on its own branch, exactly as #459 requires: the Next version is independent of any feature work,
so it must not be folded into one.

## Root cause (verified, not paraphrased)

- `package.json` declares `"next": "^16.3.8"`. `package-lock.json` and `node_modules` both resolve to **16.4.0** -
  the top of the vulnerable range. There is exactly ONE copy: `npm ls next --all` reports only the root entry, and
  no other package in the lock depends on or peers on `next`.
- `eve@0.44.4` declares no `next` peer and no `next` dependency (it only exposes an `eve/next` subpath), so nothing
  constrains the target version.
- Dependabot, queried directly rather than summarized: **23 open alerts**. Three are `next`, all with range
  `>=16.0.0, <=16.4.0` and `first_patched_version` **16.4.1**:

| advisory            | severity | title                                                                     |
|---------------------|----------|---------------------------------------------------------------------------|
| GHSA-2464-fhr4-w9xw | critical | Unauthenticated RCE in the Image Optimization API when SVG files are used |
| GHSA-673q-mjm6-r5xr | critical | Unauthenticated RCE in `use cache` functions returning typed arrays       |
| GHSA-p3m5-59mp-jv5r | high     | Denial of Service in the App Router using Server Actions                  |

- `next build` queries the npm bulk advisories endpoint and refuses the FIRST run with `SecurityFatalError`; a retry
  passes because the nudge fires once per invocation. That is why the local build gate is red once per session and
  green thereafter - a red gate with a security message attached, which invites a "just retry it" habit.

## Reachability (measured, not assumed)

All three advisories are currently UNREACHABLE in this application:

- **no `next/image` usage.** `git grep` finds the path only in `next-env.d.ts` (the generated
  `next/image-types/global` reference) and in `proxy.ts` (a matcher that EXCLUDES `_next/image` from the proxy).
  Neither renders an image.
- **no `"use cache"`** anywhere in tracked files.
- **no `"use server"`** anywhere, so there are no Server Actions.
- `next.config.ts` is deliberately empty (`const nextConfig: NextConfig = {}`, wrapped by `withEve`), so
  `images.dangerouslyAllowSVG` sits at its default `false` and the optimizer refuses SVG outright.

So this fix removes a deployed RCE surface and a flaky red build gate. It is not incident response, and the plan
should not be padded as if it were.

## Intended fix

Bump the direct dependency to the latest patch inside the same major: **16.4.3**.

- It is the `latest` dist-tag, and 16.4.1 is the first patched version, so 16.4.3 sits comfortably above the floor.
- **Narrowest lever: no `overrides` at all.** The declared `^16.3.8` range already admits 16.4.x, so nothing needs
  forcing; an override would outlive its reason and could pin an older version later.
- Raise the declared floor to `"next": "^16.4.3"`, so a future `npm install` cannot resolve back into the vulnerable
  range. Leaving `^16.3.8` would make correctness depend on the lockfile alone.

## Tasks (TDD)

1. **RED** - a lock-reading guard, `tests/dependency-advisories.test.ts`, that fails while any `next` copy resolves
   inside `>=16.0.0 <=16.4.0`. It must carry the **non-vacuity anchor** (assert it found at least one `next` copy, so
   an empty scan cannot pass) and the **boundary** case (16.4.1 must NOT be flagged; only strictly below it is
   vulnerable).
2. **GREEN** - `npm install next@16.4.3`, and set the spec floor; the guard passes.
3. **Prove the lock diff is CONFINED.** Build `{key: version}` maps from `origin/main`'s lock and the new one and
   print the symmetric difference. Every differing key must be `next`, a `@next/swc-*` platform binary, or
   `@next/env`. Anything else is a finding to explain, not churn to accept.
4. **Verify on the upgraded tree**, which is #459's own required list: full suite, `tsc --noEmit --incremental false`,
   the build gate TWICE asserting no `SecurityFatalError` on the FIRST run, and `npx playwright test`.
5. **Confirm the alerts closed** (`/dependabot/alerts?state=open`) for the three `next` advisories once merged.

## Files likely to change

- `package.json` - the `next` spec floor.
- `package-lock.json` - the resolved `next` plus its platform binaries.
- `tests/dependency-advisories.test.ts` - the new guard (RED first).
- `docs/adr/0061-advisories-are-cleared-per-package.md` and the ADR index.

## Validation

E2E runs with the store environment the CI job uses, including the scan store added by #465, so the run mirrors CI
rather than a bare `playwright test`. The build gate is run twice on purpose: the first invocation is the one the
advisory nudge breaks, so a single green run would not prove the symptom is gone.

## Risks and open questions

- **The other 20 open advisories are NOT in this change.** By package: `vite` (7), `undici` (6), `dompurify` (3),
  `@vitest/mocker` (2), `zod` (1), `postcss-selector-parser` (1), and one further package already covered by
  the open dependabot PR #346. Widening this change to cover them would mix seven unrelated upgrade risks into
  one review.
  I propose a second change for the remainder and will file an issue for it unless you would rather bundle.
- **E2E needs a Playwright browser locally.** If `npx playwright install chromium` cannot run here I will say so
  rather than report an E2E pass I did not observe.
- **A Next patch can move its own transitive deps** (styled-jsx, postcss, `@next/env`). Task 3 catches that and every
  differing key gets explained.
- **The guard covers only the advisories being cleared.** It gains a row per package as each is fixed; it must not
  become a global allowlist that quietly tolerates a new advisory.
