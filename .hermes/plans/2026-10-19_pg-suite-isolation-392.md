# #392 — the Postgres-backed suites must stop interfering

**Issue:** #392 (`bug`, `enhancement`) · **Branch:** `fix/pg-suite-isolation-392` · **Base:** `4745f28`

## What the issue already establishes — not re-derived here

Five runs of the full suite on an 8-core machine, with the failing test **and line moving every time** (a race
signature, not a logic error); the same file passing 11/11 alone; CI (a ~4-core runner) not having seen it, which is
consistent with a worker-count effect rather than immunity; and two consequences that make it more than a flaky test:

- it **corrupts the coverage measurement** (a failing test does not execute the code it would have covered), which
  made the ratchet red with no change in coverage; and
- `coverage:ratchet --update` records whatever the summary says, so running it after a flaky failure would commit a
  **permanently lower floor**.

Its own proposal: isolate the database per test file (a schema or database per worker/file, with cleanup scoped to
it), or serialize the Postgres-backed suites as an interim step.

## What R2 adds as evidence

Adding one Postgres suite (#404 R2) reproduced the interference deterministically enough to name it:

- the new suite fails **2/4 when vitest runs it alongside `active-run-claim`**, while **each passes 4/4 alone**
  against the same database;
- against a **freshly created database**, the **pre-existing** #328 suite fails 1/4 — its cleanup returns early when
  the tables are absent, so "nothing to clear" is really "nothing has created the tables yet". *Creating a database
  is not creating a schema.*

## The design: a schema per suite, derived from the DSN the operator already sets

PostgreSQL accepts a `search_path` option in the connection string, so a suite can be namespaced by handing it a DSN
identical to the operator's except for its search path:

Each suite is handed the operator's DSN plus one added parameter: PostgreSQL's `options`, carrying
`-c search_path=<suite schema>`. Nothing else about the connection changes.

**And this needs no store changes — verified before planning it.** The Postgres stores create and query table names
**unqualified** (`CREATE TABLE IF NOT EXISTS df_run_summaries`, `FROM df_run_summaries`, `INTO df_…`) with no
`public.` qualifier anywhere in `run-history-postgres.ts`, so the search path is what resolves them. That was the
plan's largest risk, and it is answered rather than deferred.

Each suite then owns a schema, and `DROP SCHEMA … CASCADE` + `CREATE SCHEMA` replaces per-row cleanup. Isolation
becomes a property of the fixture instead of a discipline every suite must remember — today each suite deletes only
its own rows (`WHERE repo LIKE 'owner/<suite>-%'`), which cannot isolate it from another suite's in-flight run
against the shared partial UNIQUE claim index.

**The bootstrap goes where a bootstrap already belongs.** `tests/dark-factory/pg-global-setup.ts` exists (40 lines,
a default `setup()` that today only notices whether tables exist). It creates each suite's schema before the workers
start, so a fresh database fails loudly at setup instead of as a mysterious write failure inside an unrelated
assertion — which also closes the fresh-database gap above.

## Fallback, if the schema route does not land cleanly

Serialize the six Postgres-backed suites (per-file serialization for those files only) and keep the bootstrap. That
is the issue's own interim, it is smaller, and it would ship as its own release rather than being smuggled in. The
decision point is task 1: a `search_path` the stores do not honour sends us here.

## Tasks

Each is a RED/GREEN pair where a test is the deliverable.

| # | task | notes |
|---|---|---|
| 1 | `testDsnFor(baseDsn, suite)`: derive a per-suite DSN by setting the `search_path` option | pure, so the derivation is proven without a database; must preserve an existing `options=` rather than replace it, and refuse loudly on a form it does not understand |
| 2 | `pg-global-setup` creates each suite's schema (drop + create), and reports what it created | also fixes the fresh-database gap |
| 3 | The six pg suites take their DSN from it | sqlite suites untouched |
| 4 | Prove isolation: the previously-interfering pair, run together, **5 times** | the issue's first acceptance criterion |
| 5 | Prove the ratchet consequence is gone: two consecutive full runs with all five DSNs give **identical coverage numbers** | the issue's second criterion |
| 6 | An ADR: test isolation is a schema per suite; the shared-database reset is deliberately replaced | + a line in the docs page that covers the test harness |
| 7 | Assert the fix did not serialize everything: the sqlite suites still run in parallel | reducing workers would "fix" this by making the suite slow, which is not a fix |

## Validation

- With all five `DF_*_TEST_DATABASE_URL` variables set, the full suite passes **repeatedly** (5 runs) on this 8-core
  machine.
- The previously-failing pair, run together, is green 5/5 — today it is 2/4 red.
- Against a **fresh** database, the pg suites bootstrap and pass; today the pre-existing #328 suite fails there.
- Two consecutive full runs produce **identical** coverage numbers, so `coverage:ratchet` cannot red on a flake.
- Unchanged: `tsc --noEmit`, the sqlite suites' runtime, `eve build`, the doc/ADR/env guards, and cspell over the
  whole diff with the repository's own `.cspell.json`.

## Risks

1. **An operator DSN the derivation does not understand.** It may already carry `options=`, or be a keyword/value
   form rather than a URL. The derivation preserves what is there, or refuses with a named reason — it must never
   silently point a suite at the wrong database, because that failure looks like a product bug.
2. **A bootstrapped schema can hide a real failure.** If the bootstrap recreates tables a test expected to be
   missing, a test could pass for the wrong reason. The bootstrap states what it creates, and the fresh-database case
   stays a test of its own.
3. **Isolation must not cost the fast path.** Task 7 guards against "fixing" this by serializing a suite that did not
   need it.
4. **Two suites could still contend on one schema** if a future suite forgets to ask for its own; the helper makes
   the derived name visible in the setup output so a duplicate is observable.

## Out of scope

- The ratchet's own rules (ADR 0043 / 0046): this release makes the measurement stable, not the floor.
- CI worker counts, and the runner's own configuration.
