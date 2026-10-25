# Plan — #468: Clear the remaining npm advisories (vite, undici, dompurify, @vitest/mocker, zod, postcss-selector-parser)

- **Date:** 2026-10-25
- **Issue:** #468
- **Branch:** `fix/clear-npm-advisories-468`

## Goal

Move every resolved copy of the six packages out of its vulnerable range (the table in #468), so
`node_modules` and the lockfile resolve outside every range. Extend the advisory guard test. Report
the remaining open-alert count after merge.

## Source of truth

Live `dependabot/alerts?state=open` (20 open). Alert #29 (a math-rendering library) is already covered by the open
dependabot PR #346 and is out of scope. The six in scope: `vite`, `undici`, `dompurify`,
`@vitest/mocker`, `zod`, `postcss-selector-parser`.

## Current resolved tree (from package-lock.json)

- `vite` 8.2.2 (hoisted; declared by `vitest` `^6.0.0 || ^7.0.0 || ^8.0.0`)
- `undici` 7.30.0 (hoisted; parents `^7.28/7.29`) + 8.11.2 under `eve` (eve pins exact `8.9.0`) + 8.11.2 under `jsdom` (jsdom `^8.10.2`)
- `dompurify` 3.4.16 (declared by `mermaid` `^3.3.3`)
- `@vitest/mocker` 4.1.11 (declared by `vitest` 4.1.11 exact)
- `zod` 4.4.3 (**DIRECT**, root exact) + 4.1.11 under `@vercel/cli-config` (exact)
- `postcss-selector-parser` 6.0.10 (declared by `@tailwindcss/typography` 0.5.20 exact)

## Per-package lever (narrowest first)

| Package                    | Current | Target                                 | Lever                                                                                                               |
| -------------------------- | ------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `vite`                     | 8.2.2   | 8.2.4+ (npm update → latest 8.x 8.3.5) | `npm update vite` (vitest range admits)                                                                             |
| `undici` 7.x               | 7.30.0  | 7.30.1+                                | `npm update undici`                                                                                                 |
| `undici` 8.x (jsdom)       | 8.11.2  | 8.12.2+                                | `npm update undici` (jsdom `^8.10.2` admits)                                                                        |
| `undici` 8.x (eve)         | 8.11.2  | 8.12.2+                                | override `eve → undici ^8.12.2` (eve pins exact 8.9.0)                                                              |
| `dompurify`                | 3.4.16  | 3.4.17                                 | `npm update dompurify` (mermaid `^3.3.3` admits)                                                                    |
| `@vitest/mocker`           | 4.1.11  | 4.1.12                                 | override `vitest → @vitest/mocker ^4.1.12` (vitest pins exact 4.1.11)                                               |
| `zod` (root)               | 4.4.3   | 4.6.6+                                 | raise root `zod` floor to `^4.6.6`, then `npm install`                                                              |
| `zod` (@vercel/cli-config) | 4.1.11  | 4.6.6+                                 | override `@vercel/cli-config → zod ^4.6.6` (exact pin)                                                              |
| `postcss-selector-parser`  | 6.0.10  | 7.1.6+                                 | override `@tailwindcss/typography → postcss-selector-parser ^7.1.6` (exact pin; MAJOR jump — verify tailwind build) |

## Overrides to add (package.json)

```json
"overrides": {
  "eve": { "undici": "^8.12.2" },
  "vitest": { "@vitest/mocker": "^4.1.12" },
  "@vercel/cli-config": { "zod": "^4.6.6" },
  "@tailwindcss/typography": { "postcss-selector-parser": "^7.1.6" }
}
```

No GLOBAL override (would force every consumer across a major boundary). Each is scoped to the
exact-pinning parent. The `@vitest/mocker` 4.1.12 published version is confirmed at implementation
time; if 4.1.12 is unpublished, the latest 4.1.x patch is used.

## Verification (dependency-vulnerability-remediation steps)

1. `npm install` regenerates the lock.
2. **Confine the lock diff** — build `{key: version}` maps from `git show origin/main:package-lock.json`
   and the new lock; print the symmetric difference. Every differing key must be one of the six
   targets or a platform binary. Re-check after each override (a scoped override can still re-resolve
   a sibling onto the overridden version).
3. Confirm every copy's version sits inside its declared range (read the lock). Note any version above
   the bot's own target (e.g. vite 8.3.5 > 8.2.4) — acceptable within the parent range, reported.
4. Extend `tests/dependency-advisories.test.ts` `GUARDED_ADVISORIES` with a row per package (two rows
   for undici's two major lines), keeping the non-vacuity anchor and the first-patched boundary case.
5. Re-query `dependabot/alerts?state=open` after merge; report the count.

## Validation (local gates)

- `npx vitest run tests/dependency-advisories.test.ts` (guard green)
- full `npx vitest run` (2805+ passing)
- `npx tsc --noEmit --incremental false`
- `npx cspell@9.1.1 -c .cspell.json <changed files>`
- `prettier@3 --check` on changed files
- `npm run build` (or the app build) — specifically to confirm the postcss-selector-parser 7.x major
  bump does not break the tailwind/typography frontend build (the single highest-risk change).

## Risks / open questions

- `postcss-selector-parser` 6 → 7 is a MAJOR API change under `@tailwindcss/typography` 0.5.20 (which
  pins 6.0.10 exactly and is already at latest). If the override breaks the tailwind build, the build
  gate will catch it; if it cannot be satisfied safely, that one package is called out as the remaining
  alert rather than shipped broken. #468 explicitly lists it, so the intent is to clear it.
- `vite` / `@vitest/mocker` are build/test-only; `undici` 8.x under `eve` is runtime but the override
  pins to a range, not an exact version, so future patches still flow.
