# 0052 — Postgres test suites are isolated by a schema per suite

- **Status:** Accepted
- **Date:** 2026-10-19
- **Issue:** #392

## Context

The Postgres-backed suites share one database, and — the part that makes this a real problem — **three of them share
the same tables**: `run-history-postgres`, `active-run-claim` and `retire-run-claim` all create and query
`df_run_summaries`, `df_run_events` and `df_run_deliveries`.

Test files run in parallel. The observed failures were non-deterministic and **moved**: the failing test and even the
failing line changed from run to run, on `main` as well as on feature branches, while each file passed alone. That is
the signature of a race, not a logic error, and the shared partial UNIQUE index on the active-run claim is exactly
the kind of state two concurrent suites contend over.

Two consequences made it more than a flaky test:

- a failing test does not execute the code it would have covered, so measured coverage falls — the ratchet went red
  with no change in coverage at all; and
- `coverage:ratchet --update` records whatever the summary says, so updating after a flaky failure would commit a
  **permanently lower floor**.

The previous answer, a one-shot `TRUNCATE` of every table in the global setup, is race-free *at setup* but does
nothing about two suites running concurrently afterwards, and it cannot isolate suites that share tables by design.
Separately, a brand-new database has no **schema** — creating the database is not creating its tables — which made the
pre-existing #328 suite fail on a fresh database with a write error that looked like a product bug.

## Decision

**Each Postgres suite owns a schema, and the global setup creates it.**

1. **The schema comes from the DSN the operator already sets.** A suite is handed the operator's DSN plus
   PostgreSQL's `options` parameter carrying `-c search_path=<suite schema>`. No store changes are needed, because
   the stores create and query their table names **unqualified** — verified rather than assumed.
2. **Isolation is a property of the fixture, not a discipline.** Two suites can no longer contend, even over the
   same table names, because they are different tables in different schemas.
3. **The setup creates every registered suite's schema (drop, then create) before any worker starts**, so a fresh
   database is bootstrapped explicitly and fails loudly at setup rather than as a mysterious write failure inside an
   unrelated assertion.
4. **The derivation refuses what it does not understand.** A suite name that is not a plain identifier, an empty DSN,
   or a DSN that is not a `postgres://` URL is a named error. Silently "fixing" one of those would point a suite at
   the wrong database, and that failure looks like a product bug.
5. **A space is encoded as `%20`, never left to `URLSearchParams`' `+`.** The connection-string parser
   percent-decodes but does not treat `+` as a space, so a path written with `+` would arrive as the literal
   `-c+search_path=…` and silently leave the suite in `public` — a fix that looks applied and is not.
6. **Suites are registered by the file that owns them**, so a duplicate schema is visible in the setup output.

## Consequences

- The interference is gone **by construction**: in a real run, the three run-history suites now own
  `df_test_active_run_claim`, `df_test_retire_run_claim` and `df_test_run_history_postgres`.
- A **fresh** database works, because the schema is created rather than assumed.
- The sqlite suites are untouched and still run in parallel: serialising everything would have "fixed" the flake by
  making the suite slow, which is not a fix. **The fallback of serialising the Postgres suites was designed and
  deliberately not needed.**
- A new Postgres suite must be registered (and asked for its own schema) to be isolated; an unregistered one would
  fall back to the default schema and could contend again. That is the one thing this relies on being remembered, and
  the registry is where it is visible.
- Migrating a suite is a two-line change at its DSN, which is why all six could be moved in one release.
