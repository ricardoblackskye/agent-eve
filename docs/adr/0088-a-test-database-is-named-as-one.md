# 0088 — A test database is named as one

- **Status:** Accepted
- **Date:** 2026-11-18
- **Issue:** #689

## Context

The Postgres test suites reset their tables with `TRUNCATE`, and the guard that decides whether a
database may be reset read the DSN's HOST: `_test`, `localhost` or `127.0.0.1` was enough.

The local Dark Factory launcher writes its live run ledger to
`postgres://postgres@localhost:5432/darkfactory`, so the guard accepted a database holding real run
history. The pre-push gate's one-shot global reset then truncated the rows a real run had just
recorded — the run history itself. Losing them looked like a store fault and was chased as one for
several sessions.

Neither host is a signal in the direction this guard needs. `localhost` is exactly where the live
local ledger lives, and a remote CI service container IS disposable while not being localhost.
The launcher's own preflight reads the same DSN and must keep accepting localhost: two guards, one
host, opposite conclusions — which is the evidence that the host was the wrong axis.

ADR 0052 isolates suites by schema and requires that every suite "asserts a disposable DSN before it
writes", without deciding what makes a DSN disposable. This record decides that part.

## Decision

**A database may be reset only when its NAME says it is a test database: the DSN's database name must
contain `_test`. The host is not consulted.**

1. The rule reads the URL path, which is the only part of a DSN that says what the data is for.
2. It fails CLOSED. A DSN that cannot be parsed as a URL — a keyword/value form, an empty string, a
   malformed percent-escape — is refused with the named error, never accepted.
3. The error names the rule and the fix, because this deliberately breaks every local setup whose DSN
   still says `darkfactory`.
4. CI, the documented local recipe and the docs move to `darkfactory_test` in the same change, so the
   enforced contract and the documented one are the same sentence.

## Consequences

- A suite can no longer truncate a run ledger, by construction rather than by an operator remembering.
- Renaming a database is now a migration of the test harness: an existing local setup fails loudly at
  global setup until its DSN points at a `_test` database. That failure is the feature.
- A DSN-wide substring check would have been a smaller diff and was rejected: it accepts
  `postgresql://df_test@prod-host:5432/production`, where the USERNAME carries the word. The property
  being tested is what the database is FOR, and only its name expresses that.
- ADR 0052's schema isolation is unchanged; this record narrows what 0052 relies on.
- The three test variables that were undocumented (`DF_RUN_HISTORY_TEST_DATABASE_URL`,
  `DF_COST_BUDGET_TEST_DATABASE_URL`, `DF_CONTROL_TEST_DATABASE_URL`) are now in `.env.example` like
  their two siblings, because a recipe that must change is worth being findable.
