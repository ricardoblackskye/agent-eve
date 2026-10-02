# 0012 — Docs reference pages are generated at render time, not committed

- Date: 2026-10-02
- Status: Accepted

## Context

The Dark Factory documentation set (introduced across #233/#234/#237) holds narrative
pages in `docs/pages/*.md`. But the *mechanical* reference — environment variables, API
routes, platform seams, database migrations, the test/eval inventory — is the kind of
content that rots the moment someone adds an env var or a route and forgets the doc.

A hand-maintained copy will drift; a generated one cannot. The choice was whether to
generate a page at build time and commit the output (a snapshot that still needs a
pipeline to stay fresh) or derive it when rendered so there is no snapshot to drift.

## Decision

Render the five reference pages **from the source of truth at build/render time** and
**do not commit the generated markdown**. The page is derived on every render, so adding
an env var, route, adapter, or migration makes it appear with no documentation edit.

Each page states what it was derived from (for example "Generated from `.env.example`
and application source — do not edit.") so a reader can verify it.

API-route posture is read from the canonical `isProtectedPath` in `app/auth-gate.ts` —
machine-readable and already unit-tested — rather than guessed from each route file.

## Consequences

- Documentation drift for these pages is **impossible by construction**, not merely
  detected. The separate drift-guard leg (#238) then proves the invariant stays true.
- Pipelines are reserved for content that genuinely must be snapshotted — the GitHub
  issue graph (leg 4) — because it is not in the repository. Generated-in-repo content
  needs no pipeline.
- A generator that throws during `generateStaticParams` fails `next build`, so a broken
  source scan fails the build rather than shipping an empty page.
- The generators live in a single, testable module
  (`app/documentation/reference/generators.ts`); #238 reuses them rather than
  re-implementing the extraction.
