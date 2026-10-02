# Docs: generate reference pages from source of truth (#235)

**Branch:** `feat/docs-generated-reference-232c` (off `origin/main`)
**Epic:** #232 — Documentation enhancement (Release 2, leg 3 of 6)
**Closes:** #235

## Goal

Render the five mechanical reference pages **from the source of truth at build/render
time** so they cannot drift. No generated markdown is committed — the page is derived
when rendered. Full acceptance criteria are in the issue; the short version: adding an
env var, route, adapter, or migration makes it appear with no doc edit, generation runs
as part of `next build` and fails the build on error, and each page states what it was
derived from.

## Root cause / why now

The authored `docs/pages/*.md` set (introduced in #234) intentionally holds narrative
content. But the *mechanical* reference — env vars, routes, seams, migrations, the
test/eval inventory — is exactly the thing that rots the moment someone adds an env var
or a route and forgets the doc. A hand-maintained copy will drift; a generated one
cannot. The design decision in #235 is explicit: **do not commit generated docs**, derive
at render. Pipelines are reserved for leg 4 (the GitHub issue graph), which must be
snapshotted because it is not in the repo.

## Intended fix (architecture)

Per the approved decisions (2026-10-02), derived pages are **folded into the existing
`app/documentation/[slug]` route** rather than a separate URL space, and API-route auth
posture is read from the canonical machine-readable gate rather than guessed.

- **Extend `app/documentation/[slug]/page.tsx`** — `generateStaticParams` returns the
  union of authored md slugs (`docs/pages/*.md`) and the derived reference slugs. The
  handler renders the md file if `docs/pages/{slug}.md` exists, else generates markdown
  from the registry, else `notFound()`. The existing `[a-z0-9-]+` allowlist and
  `dynamicParams=false` are unchanged; derived slugs (`environment`, `api-routes`,
  `platform-seams`, `migrations`, `tests-evals`) satisfy it and do not collide with
  authored filenames.
- **New module** `app/documentation/reference/generators.ts` exporting a registry
  `{ slug, title, derivedFrom, generate(): Promise<string> }[]` and the five
  generators, each returning **markdown** rendered by the *existing* `ReactMarkdown` +
  `remarkGfm` + `MermaidDiagram` pipeline (reused from `[slug]/page.tsx`):
  1. `environment` — `.env.example` (active `KEY=` lines) **plus** `process.env.*`
     usage discovered by walking app source. Reuses the discovery logic already in
     `tests/env-example-coverage.test.ts`, lifted into a shared helper so leg 6 can
     reuse it too.
  2. `api-routes` — a **machine-readable** `listApiRoutes()` scan of `app/api/**/route.ts`
     returns `{ path, methods, protected }[]`: path from the file location, methods from
     the exported `GET`/`POST`/… handlers, and `protected` computed from the canonical
     pure `isProtectedPath(path)` in `app/auth-gate.ts` (already unit-tested) — **not** a
     heuristic parse of each route file. The reference page renders this table.
  3. `platform-seams` — each seam interface and its `console` / `sqlite` / `postgres`
     implementations, discovered by scanning the adapter directories.
  4. `migrations` — `db/migrations/` file list with a short description parsed from
     each migration's comment header.
  5. `tests-evals` — `tests/**` and `evals/**` inventory (describe blocks / eval names).
- **Edit** `app/documentation/page.tsx` to add a "Generated reference" section linking
  each derived slug (now served at `/documentation/<slug>` by the extended route).
- Every generated page carries a header line stating what it is derived from (e.g.
  *"Generated from `.env.example` and application source — do not edit."*) so a reader
  can verify it.
- **Build gating:** generators run inside `generateStaticParams`/render, so a throw
  fails `next build`. A unit test asserts all generators run without throwing and return
  non-empty content — that covers "generation runs as part of the normal build; a failure
  fails the build" and catches a silently empty page.

## TDD phases

- **RED** — `tests/docs-reference.test.ts`: import the registry; for each of the 5
  slugs assert the generated markdown contains a token that can only come from source
  (e.g. `environment` includes a real `.env.example` key; `api-routes` includes a known
  `app/api/...` path; `migrations` includes a real migration filename). The test fails
  (module/exports absent) before GREEN. Commit the RED test.
- **GREEN** — implement `generators.ts` + the `reference/[slug]/page.tsx` route + the
  index section. Make the full suite and `tsc --noEmit --incremental false` green.
- **REFACTOR** — extract the env-var discovery into a shared helper used by both the
  new generator and `tests/env-example-coverage.test.ts`, so leg 6 (#238) and this leg
  share one source of truth. Keep tests green.

## Files likely to change

- `app/documentation/reference/[slug]/page.tsx` (new)
- `app/documentation/reference/generators.ts` (new)
- `app/documentation/page.tsx` (add reference section)
- `tests/docs-reference.test.ts` (new)
- `tests/env-example-coverage.test.ts` (refactor to share the discovery helper — only if
  the shared helper lands)
- `docs/adr/0012-*.md` (new) + `docs/adr/README.md` (index link)

## Validation

- `npx vitest run tests/docs-reference.test.ts` and the full suite — green.
- `npx tsc --noEmit --incremental false` — 0 errors (the type-check is the RED anchor,
  run non-incrementally — see the workflow skill's false-green note).
- `npm run build` — succeeds; confirm the five `/documentation/reference/*` pages are
  emitted, and that *intentionally breaking a generator* (e.g. pointing at a missing
  source) makes the build fail.
- `npx cspell@8` + `markdown-table-formatter` on changed files, including the new ADR
  and this plan.
- E2E: add a link assertion in `e2e/documentation.spec.ts` for the new reference
  section if it is not already covered; otherwise rely on unit + build.

## Risks / open questions

- **Fragile source scanning.** Glob/regex extraction of seams and migrations can miss
  items if naming varies. Mitigation: generators assert non-empty output and the RED test
  pins at least one real token per page, so a silent miss fails the test rather than
  rendering an empty page.
- **Leg 6 dependency.** #238 (drift guards) will reuse these generators; keeping them in
  a shared, testable module is deliberate so leg 6 does not re-implement extraction.

**Decisions locked (2026-10-02):**
1. API-route auth posture is read from the canonical `isProtectedPath` in
   `app/auth-gate.ts` — machine-readable, not heuristic.
2. Derived pages are folded into the existing `app/documentation/[slug]` route, not a
   separate `/reference/` space.

## ADRs (written in this change)

- **0012 — Reference pages are generated at render time, not committed.** Encodes the
  #235 design decision and why pipelines are reserved for leg 4 (only the GitHub issue
  graph needs snapshotting because it is not in-repo). Complements ADR 0009 (Tailwind)
  and ADR 0010 (documentation is a docs tree). Linked from the ADR index.
