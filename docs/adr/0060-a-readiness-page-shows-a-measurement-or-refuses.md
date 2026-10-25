# 0060 — A readiness page shows a measurement or refuses

- **Date:** 2026-10-25
- **Status:** Accepted

## Context

The AMM scanner (#426, #437) measures a repository and returns a scan. The command that ran it
printed that scan to stdout and returned: the store's only writer was the test suite. Nothing in
the web app read the store either — the database adapter was referenced only by tests, and both
readiness pages called a zero-argument factory that returned the **fixture**: a hard-coded scan of
this repository, 74/100.

So the board showed a number that no run had produced, for one repository, whatever had actually
been scanned and whether or not anything had been. That is worse than an empty state, because a
fabricated figure is indistinguishable from a measurement. The provider module had already decided
this exact question for itself (#424: an unconfigured driver throws rather than falling back to the
fixture, "which looks like a measurement and is not one") — but the pages were on the other side of
that decision, reading the fixture directly.

Two smaller failures sat behind the same symptom. A page looked up the normalized (lower-case) repo
from its configuration while the store matched the repo column exactly, so a scan recorded against
`Owner/Repo` could never be found. And the factory that builds a store owned a database handle that
nothing released.

## Decision

A measurement is persisted where it is taken, and a readiness page renders what was measured or
refuses.

The scan command records the scan it measured through the configured store and reports which store
and which row it wrote. It exits non-zero only when a **configured** store refused the write, since
a scan that was printed but not persisted still exists for the operator reading the terminal.

The pages read through one page-facing selector, which is the database adapter over the configured
store, and which throws when no driver is configured. The fixture stays exported for tests and is no
longer reachable through any zero-argument factory: the factory that returned it is deleted, so the
fallback cannot be reintroduced by calling it.

The detail page is a client component, so it reads across a server boundary — a route guarded by the
same viewer resolution the runs board uses. The repo is normalized at the store boundary, on write
and on read, matching how the run ledger treats it, so casing cannot decide whether a scan is found.

## Consequences

Every runtime that renders these pages now requires the store to be configured, including a preview
deployment. A preview without it errors instead of showing a figure. That is the cost accepted here:
the alternative is a fabricated figure in preview, which is the defect this record exists to prevent.

The readiness seam gained an optional release, called by the pages and the route. A factory that
creates a database handle must offer to close it: without one, a server render leaks a handle per
request, and under the local driver an open handle also blocks its file.

No data migration is needed, and that is a consequence of the defect rather than luck: because
nothing had ever written a scan in production, the store is empty and there is no old casing to
correct.

Anything that renders readiness now needs a measurement to exist first, so a freshly migrated
environment shows an empty board until a scan runs. That is the honest empty state, and it is
deliberately not softened by a placeholder scan.
