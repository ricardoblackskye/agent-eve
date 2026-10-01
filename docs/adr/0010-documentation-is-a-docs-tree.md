# 0010 — Documentation is a docs/ tree served by server components

- **Date:** 2026-10-01
- **Status:** Accepted

## Context

`ARCHITECTURE.md` had grown to 418 lines and 12 top-level sections, with the Dark
Factory internals appended to what was originally a deployment overview. One file
could no longer serve one audience, and its rendering was a client component that
`fetch`ed the markdown at runtime — flashing empty before hydration.

Three things forced decisions: `docs/` was **not** a documentation tree (it also
holds `adr/`, mockups, a zip and wireframes); the existing Mermaid renderer was
worth reusing rather than rebuilding; and `/architecture` was already linked and
bookmarked.

## Decision

- **`docs/pages/` is the documentation route root.** Not `docs/` itself, so the
  ADRs, mockups and a zip are not published as pages. Not a manifest either — a
  manifest is a second source of truth that can drift from the directory.
- **Server components.** The pages are read from disk at build time and rendered
  statically, reusing `react-markdown` + `remark-gfm` and the existing
  `MermaidDiagram` client component. No new dependency, no runtime fetch, no flash.
- **`/architecture` redirects** to `/documentation` rather than 404ing, and
  `ARCHITECTURE.md` is reduced to a pointer so there is exactly one source of truth.
- **The move is mechanical and guarded.** A test asserts the union of the new pages
  still carries every heading the original file had, so a dropped section fails CI
  instead of going unnoticed.

## Consequences

- Documentation can grow page by page without one file becoming the dumping ground.
- The heading-coverage guard is load-bearing: it must be updated deliberately when
  content is intentionally removed, which is the point — removal becomes a decision
  rather than an accident.
- `app/api/architecture/route.ts` is now unused by any page. It is left in place
  rather than deleted in the same change, and should be removed once nothing else
  references it.
- Pages are generated at build time, so a new page requires a rebuild — acceptable
  for documentation and cheaper than a runtime filesystem read per request.
