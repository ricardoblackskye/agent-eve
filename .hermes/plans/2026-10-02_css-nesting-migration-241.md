# CSS nesting migration (#241)

**Branch:** `feat/css-nesting-migration-232g` (off `origin/main`)
**Epic:** #232 — Documentation enhancement (Release 3, leg 7 of 7)
**Closes:** #241

## Goal
Refactor the Dark Factory component classes in `app/globals.css` from **flat selectors** to **modern CSS nesting** (`&`), with **no logic or behavior change**. This satisfies the #241 intent ("Tailwind selectors → modern CSS nesting") using the styling #233 actually shipped: plain `.df-*` component classes. Tailwind v4 stays wired via `@tailwindcss/postcss` — it is **not** removed. The two app pages (chat + architecture) are out of scope — they are not touched.

## Root cause / finding
Investigation showed the issue's literal premise ("migrate `@apply` selectors") does not match the repo: there are **zero `@apply` usages anywhere** (searched `*.css`, `*.ts/tsx/js/jsx/scss` repo-wide). #233 introduced plain `.df-*` component classes directly in `app/globals.css` (e.g. `.df-btn`, `.df-panel`, `.df-panel-head`, `.df-panel-body`, `.df-control-card`, `.df-control-panel`, `.df-btn-danger`, …). The real "modern CSS nesting" work is to convert those flat selectors to native `&` nesting for readability/scoping consistency. User confirmed this scope (2026-10-02).

## Intended fix
1. In `app/globals.css`, convert related `.df-*` flat selectors into nested form using `&`, preserving the **exact same resolved selectors and declarations**. Example:
   ```css
   .df-panel {
     /* ... */
     &-head { /* ... */ & strong { /* ... */ } }
     &-body { /* ... */ }
   }
   ```
   compiles to the same `.df-panel`, `.df-panel-head`, `.df-panel-head strong`, `.df-panel-body` rules as today.
2. Preserve source order and specificity so the rendered output is equivalent at the selector level.
3. **Do not** remove Tailwind/PostCSS — `tests/tailwind-config.test.ts` (the #233 guard) requires the `tailwindcss` / `@tailwindcss/postcss` wiring and the heading rules; this change keeps them.

## TDD
Mechanical, behavior-preserving → the test strategy locks the **resolved CSS contract**:
- **Backstop (RED→GREEN):** `tests/css-nesting-migration.test.ts` parses `app/globals.css`, resolves `&` nesting to flat selectors, and asserts **every known `.df-*` class** (the set extracted from the current file) is still present after the refactor. It also re-asserts the #233 heading rules are intact. This fails if any class is dropped/renamed — non-vacuous. It is green today (flat CSS resolves to itself) and stays green after the nesting refactor (resolved output identical).
- Run the existing Playwright/visual suite to confirm zero visual diff.

## Tasks (TDD)
- RED: write `tests/css-nesting-migration.test.ts` (selector resolver + assertions over the known `.df-*` set). Green today; becomes the regression net.
- GREEN: perform the flat→nested refactor in `app/globals.css`; confirm the test + full `vitest` + `tsc` + `cspell` + `markdown-table-formatter` + `build` are green and visual diff is zero.
- REFACTOR: no behavior change; only CSS structure.
- Pair with `automated-security-review` to confirm no logic change.

## Files likely to change
- `app/globals.css` (the `.df-*` component classes → `&` nesting).
- `tests/css-nesting-migration.test.ts` (new — the backstop).
- Possibly a small selector-resolver helper (kept inside the test or `tests/support/`).

## Validation
- `npx vitest run tests/css-nesting-migration.test.ts` — backstop green (all `.df-*` classes preserved).
- `npx vitest run` — full suite green (incl. `tailwind-config` #233 guard).
- `npx tsc --noEmit --incremental false` — 0 errors.
- `npx cspell@8` on changed files — 0 issues.
- `npx markdown-table-formatter` where applicable.
- `npm run build` — green; visual diff minimal/zero.
- `npm run lint` (MegaLinter parity) — green.
- Pair with automated-security-review: confirm CSS-only / no logic change.

## Risks / open questions
- **Resolver correctness:** the test's `&` resolver must match how the browser/Tailwind compiles nesting (concatenation for `&-x`, identity for bare `&`). Keep it minimal and validate it against the current flat file first (resolves to itself).
- **No Tailwind removal:** the #233 guard requires the Tailwind wiring; leave it.
- **App pages untouched:** only `app/globals.css` shared classes change; chat/architecture pages are out of scope.
- **automated-security-review** must sign off this is CSS-only / no logic change.
