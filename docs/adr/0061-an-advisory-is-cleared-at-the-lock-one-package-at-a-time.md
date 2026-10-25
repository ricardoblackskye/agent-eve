# 0061 — An advisory is cleared at the lock, one package at a time

- **Date:** 2026-10-25
- **Status:** Accepted

## Context

This repository carried 23 open Dependabot alerts across seven packages at once, and they arrive as a single grouped
pull request. One review then mixes unrelated upgrade risks — a runtime HTTP client, a build-only bundler, a
sanitiser — where a failure in either cannot be attributed, and the group's own description is not evidence of what
its diff does.

Two properties of the tree make a package-by-package reading necessary rather than fussy. The vulnerable version
usually lives in a NESTED copy, under `node_modules/<parent>/node_modules/<pkg>`, which a glance at the top-level
`dependencies` never shows; and a parent that pins an EXACT version cannot be fixed by updating the child at all.
Meanwhile an alert count is not a work plan: it is one query's answer, it dedupes per advisory and not per package,
and one package commonly appears three or four times.

## Decision

Advisories are cleared one package per change, at the lockfile.

The lever is the narrowest one that works: bump a direct dependency; `npm update` where the parent's declared range
already admits the patched version, which adds no override at all; an `overrides` entry only where a parent pins an
exact version. A GLOBAL override is never used — it forces every consumer across a major boundary, which is the risk
being avoided.

The lock diff is proven CONFINED by comparing the two locks by package key rather than by line, and every differing
key is explained as the target package or a platform artifact of it. Each cleared package gains a row in a
lock-reading test that carries a non-vacuity anchor and the first-patched boundary case, so the boundary version is
never flagged and the copy below it always is.

## Consequences

Each review carries one upgrade risk, and a failure is attributable to the package that moved.

An override outlives its reason: it keeps forcing its version after the parent ships a release carrying the fix, and
can end up pinning an OLDER version than the parent wants. It is therefore recorded where the syntax allows and
re-checked whenever that parent moves.

The guard is a list that grows a row per package, which means a cleared package is visible in the test rather than
implied by the lock. It has to be extended deliberately; it must not become an allowlist of packages we tolerate an
advisory against, because that would hide the next one.

Clearing one package does not clear the tree, and that is a cost rather than a by-product: the remainder becomes its
own deliverable (#468 rather than a line item in #459). It also means the open-alert list is re-read after every fix,
since the number reported is only ever "as of the query".
