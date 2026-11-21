# 0094 - A surface comes from composition, not from conventions

- **Status:** Accepted
- **Date:** 2026-11-21

## Context

The Architect resolves the "surface" a story names - the route and the page - by deriving it from the
repository. Three failures on `ricardoblackskye/local-promotion-site` showed where that derivation was
too narrow:

1. A Vite/React SPA declares its home page as a function in the route table's own file (`src/App.tsx`),
   so the route element is not in that file's imports. Resolving a route element through imports alone
   skipped it, and a story about "the main page" had no surface: the run parked with "no page could be
   identified".
2. Every page was imported through a path alias (`@/pages/BlogPostPage`), and the specifier collectors
   matched relative paths only, so the composition chain was invisible.
3. Issue #12 named a file outright (`src/pages/BlogPostPage.ts`) and resolved nothing, because no code
   path considered a path written in the story.

Each is the same defect in a different place: the answer was sought in a convention rather than in what
the repository itself declares.

## Decision

**Derive a surface from composition, and take the repository's own declaration as the evidence.**

- A path the story names, and which exists, IS the surface. This needs no framework knowledge at all,
  and it works in a project with no route table.
- A route element that is a component DECLARED in the route file makes that file the page - the file
  renders it, so the file is the page's home.
- An import specifier names something in this repository when it is relative OR matches a declared
  alias. The alias map is supplied by the caller: which config declares it is not this module's business.
- A bare package name is still ignored. It says nothing about this repository.

**The refusal to guess stays.** A page-scoped story whose surface cannot be resolved still parks and asks
a human. This widens what can be DERIVED; it does not widen what may be ASSUMED.

## Consequences

- A new repository is usable without first being Next.js-shaped, and without a code change per framework.
- The behaviour is deterministic and testable: no model call is involved, and every supported shape is a
  fixture.
- A route declared dynamically, or a surface referred to only obliquely ("the page about us"), still
  parks. That is the intended failure: a named outcome, not a guess.
- The `app/`/`components/` target convention in the plan validator is a separate matter and remains. It
  can refuse a CORRECT target in a repository that keeps its pages elsewhere - tracked as #727.
