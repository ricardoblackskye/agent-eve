# Docs drift guards that fail CI (#238)

**Branch:** `feat/docs-drift-guards-232f` (off `origin/main`)
**Epic:** #232 — Documentation enhancement (Release 3, leg 6 of 6)
**Closes:** #238

## Goal

Make documentation drift **fail CI**, following the repo's existing doc-consistency
pattern (`tests/env-example-coverage.test.ts`). Four guards, each a vitest test that
runs in the standard Unit Tests pipeline (not a separate opt-in workflow) and fails
with an actionable message naming the offending file. As part of this work,
**document all 61 Dark Factory modules** so the "every module documented" guard is
green today and any future undocumented module fails CI. (Scope confirmed with the
user: write real sections for the 33 currently-undocumented modules; the other 28
are already referenced from `dark-factory.md` / the flow pages.)

## Root cause

The docs describe the Dark Factory, but nothing enforces they stay in sync with the
code. A module can ship undocumented, an ADR can be orphaned, a relative link can
rot, or a generated reference page can silently diverge from its source. The
existing `env-example-coverage` test proves the pattern works; this issue extends it
to the four drift classes below. Per the epic: **drift must fail CI, not auto-open a
PR** — a guard that fails vacuously is worse than no guard, so every assertion is
scoped and unit-tested.

## Intended fix

### Four guards — `tests/doc-drift-guards.test.ts`

Each guard is a **pure function** `(scanned data) => violations[]` plus (a) an
integration test over the real repo (green today) and (b) a **mutation test** that
injects a synthetic drift and asserts the guard fires — this proves the guard is not
vacuous. All four run in the standard `vitest` Unit Tests CI job, so they are not a
separate workflow.

1. **No orphan ADRs.** Every `docs/adr/NNNN-*.md` (except `README.md` /
   `template.md`) must be linked from `docs/adr/README.md`. Fails naming the
   orphan. (`docs/pages/*.md` is auto-listed by `app/documentation/page.tsx`, so
   those cannot be orphaned; ADRs are the pages that can be silently dropped — the
   skill's own drift-guard rule.)
2. **No dead internal links.** For every `docs/pages/*.md`, resolve each relative
   `.md` link and every `../adr/*.md` link against the file and assert the target
   exists on disk. Fails naming the file + the broken link + what to fix. Runs in
   vitest and complements MegaLinter's `markdown-link-check` by living in the
   standard pipeline.
3. **Derived pages match source.** Import the generators from
   `app/documentation/reference/generators.ts` and assert each generated page
   (environment / api-routes / platform-seams / migrations / tests-evals) reflects
   the actual source: the env page lists the env vars the code reads, the
   api-routes page lists the route handlers that exist under `app/api/`, the
   platform-seams page lists the seam/adapter modules that exist. A broken
   generator (one that no longer reads source) makes CI red.
   *Risk:* if `generators.ts` cannot be imported in the node env because of a
   Next-only dependency, extract the pure source-scan helpers into a small module
   and test those instead.
4. **Every Dark Factory module documented.** Scan `agent/lib/dark-factory/**/*.ts`
   (non-test). Each module's path string must appear in at least one
   `docs/pages/*.md`. Fails naming the undocumented module. This is the "stop the
   next subsystem arriving undocumented" guard — a new module must be added to the
   docs or CI fails.

### Module documentation — `docs/pages/dark-factory-modules.md` (new)

A module-reference catalog with a section per Dark Factory module:

- the **33 currently-undocumented** modules get **real sections** — one-paragraph
  purpose, key exports/functions, a link to the code, and a link to the relevant
  ADR where one explains the design;
- the **28 already-documented** modules get a brief entry that points at the
  existing page/section plus the code link.

This makes guard 4 green today (all 61 referenced) and is the single authoritative
index. `dark-factory.md` links to it. Accuracy matters: implementation reads each
module before writing its section.

## Tasks (TDD)

- **RED:** write `tests/doc-drift-guards.test.ts` — four `describe` blocks, each
  with the pure guard function + integration test (green on `main`) + mutation test
  (red when drift is injected). Confirm each mutation test fails for the right
  reason (guard fires), not because the fixture can't load.
- **GREEN:** implement the four guard functions; author `dark-factory-modules.md`
  (all 61 sections). All four guards green.
- **REFACTOR:** keep guard functions dependency-light; consistent failure messages
  (`<file>: <what to do>`).
- **ADR 0013 (optional):** "doc drift fails CI, not auto-PR" — include only if it
  adds *why* not already in the epic issue. The constraint is already stated in the
  epic, so this is likely unnecessary.

## Files likely to change

- `tests/doc-drift-guards.test.ts` (new) — the four guards + mutation proofs.
- `docs/pages/dark-factory-modules.md` (new, large) — 61 module sections.
- `docs/pages/dark-factory.md` (link to the new catalog).
- `docs/pages/README.md` (TOC entry for the catalog).
- `app/documentation/reference/generators.ts` (only if a pure source-scan helper
  must be extracted for guard 3 importability).
- `docs/adr/README.md` (only if ADR 0013 is added).

## Validation

- `npx vitest run tests/doc-drift-guards.test.ts` — green (incl. mutation proofs).
- `npx vitest run` — no regressions (baseline 1645 passed).
- `npx tsc --noEmit --incremental false` — 0 errors (note: `vitest` does not
  typecheck; tsc is a separate gate).
- `npx cspell@8` on the new test/doc files — 0 issues (module basenames / acronyms
  that cspell flags get added to `.cspell.json`, never weakened).
- `npm run build` — green (guard tests are node-env; no UI impact).
- **Local lint gate (MANDATORY before push):** run cspell + the repo's lint on the
  changed files locally and clear every finding before pushing — MegaLinter parity.

## Risks / open questions

- **Large doc surface.** Documenting the 33 modules is the bulk of the work (user
  accepted this scope). Each section must be accurate — implementation reads each
  module before writing its section, and links to code + ADR rather than
  re-describing mechanics (which the mechanic catalog / flow pages already cover).
- **Generator importability** for guard 3 (see Risk above) — verify early in GREEN.
- **cspell** will likely flag module basenames / acronyms in the catalog; those are
  added to `.cspell.json`, not worked around.
- **No new ADR strictly required** — the "fail CI, not auto-PR" decision is already
  in the epic; an ADR would only restate it unless it captures new *why*.
