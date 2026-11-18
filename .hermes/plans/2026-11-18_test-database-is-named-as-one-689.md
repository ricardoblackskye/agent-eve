# A test database is named as one — implementation plan

**Goal:** make the destructive Postgres test reset refuse any database that is not named as a test
database, so a test run can never truncate the local Dark Factory ledger.

**Issue:** ricardoblackskye/agent-eve 689 (found during the WebFeedPOC 232 end-to-end run).

**Architecture:** the guard's axis changes from the DSN's *host* to its *database name*. Tests, CI and
the documented local recipe then all point at a `darkfactory_test` database, which leaves the
launcher's `darkfactory` ledger untouched.

**Tech stack:** TypeScript, Vitest, Postgres 16, GitHub Actions.

---

## Root cause (verified, not inferred)

`tests/dark-factory/pg-test-helpers.ts:40` decides whether a DSN may be handed to destructive SQL:

```ts
export function assertDisposableDsn(connectionString: string): void {
  const lowered = connectionString.toLowerCase();
  const disposable =
    lowered.includes("_test") ||
    lowered.includes("localhost") ||
    lowered.includes("127.0.0.1");
```

The local launcher writes its live ledger to exactly such a DSN — `df232-run.sh` line 50:

```text
DF_RUN_HISTORY_DATABASE_URL="postgres://postgres@localhost:5432/darkfactory?sslmode=disable"
```

`localhost` in the DSN is enough for the guard to accept it, so the reset runs against the live
ledger. `tests/dark-factory/pg-global-setup.ts` then truncates, once, before any worker starts:

```ts
const targets = new Set(
  DSN_VARS.map((name) => (process.env[name] ?? "").trim()).filter((dsn) => dsn.length > 0),
);
for (const dsn of targets) {
  await resetPgTables(dsn, allTables);
}
```

`allTables` is every table in `PG_TABLES` — which includes `df_run_summaries`, `df_run_events` and
`df_run_deliveries`. `df_plans` is in no list, which is why a truncated run history looked like a
partial, confusing record rather than a wipe:

```text
BASELINE before a local run:  summaries=0  deliveries=0  plans=13
AFTER the local run:          summaries=1  deliveries=1   run ceae2525-... (blocked)
AFTER the pre-push gate:      summaries=0  deliveries=0  plans=13
```

Two further facts, both read from the live machine rather than reasoned about:

- the container holds nine `df_test_*` schemas **inside** the launcher's `darkfactory` database —
  the test harness and the live ledger share one database today;
- the regression is pinned by a test that asserts the bug is correct —
  `tests/dark-factory/pg-test-helpers.test.ts:20` accepts the launcher's DSN as disposable.

## Intended fix

One rule, stated once: **a DSN may be reset only when its database NAME identifies a test database.**

1. Parse the DSN as a URL and take the pathname (the database name), lowercased.
2. Require that name to contain `_test`. The host is not consulted at all.
3. Fail **closed** on anything unparseable. A keyword/value DSN (for example `host=localhost port=5432`) is refused
   with the named error, not a `TypeError` escaping from `new URL()`.

Then move everything that runs those suites onto a database that satisfies the rule:

4. CI: `POSTGRES_DB: darkfactory_test` and the five `DF_*_TEST_DATABASE_URL` values.
5. The documented local recipe (AGENTS.md): create `darkfactory_test` in the existing container.
6. README and the two `.env.example` comments, so the documented contract matches the enforced one.

## Settled decisions

**D1 — the axis is the database name, not the host.** The issue asks for "the guard's own first
alternative", which reads as an `includes("_test")` check over the whole DSN. This plan goes one step
further and checks the *database name* only. Reason: a DSN-wide substring accepts
`postgresql://df_test@prod-host:5432/production`, because the *username* carries the word. The
property that matters is that the database exists to be destroyed, and that is the name. This is a
deliberate deviation from the issue's literal wording and is called out here rather than buried.

**D2 — CI's database is renamed in the same change, and this is not optional.** CI's DSNs are
`.../darkfactory` (`.github/workflows/ci.yml` lines 61-68) and its service sets
`POSTGRES_DB: darkfactory` (line 46). With the tightened guard, CI's suites would fail at global
setup unless they are updated together. Renaming inside an ephemeral service container is harmless.

**D3 — one existing fixture must change, and that is a correction rather than a weakening.**
`pg-test-helpers.test.ts:23` accepts `postgresql://df_test@127.0.0.1:55432/df_run_history`. Its
database name is `df_run_history`, which is not a test database — it passed only because of the
`127.0.0.1` alternative this change removes. The fixture becomes `.../df_run_history_test`. Stating
this explicitly because quietly editing an existing safety test is how a guard gets disarmed.

**D4 — existing local setups break loudly, on purpose.** Any local run whose DSN still says
`darkfactory` now fails at global setup. The mitigation is that the failure names the rule and the
fix, and the recipe change ships in the same PR.

**D5 — a new ADR, not an in-place amendment of 0052.** ADR 0052 governs the schema-per-suite
isolation and already carries a `## Amendment` section from #409, so amending in place has precedent
here. This plan still proposes a new record, because it decides something 0052 does not: what makes a
database disposable. 0052's decision is untouched. Number: `0088-a-test-database-is-named-as-one.md`.

**D6 — considered and NOT included.**

- *Removing the default-schema truncate loop.* Since 392 every registered suite owns a schema, so the
  loop now only covers unregistered suites — but registration is enforced by a test that scans
  `tests/dark-factory/` only. A scratch suite elsewhere would still rely on the loop, and deleting it
  would reintroduce the 332 flake. Kept.
- *A source-regex guard that CI's `ci.yml` DSNs are test databases.* A runtime guard already refuses
  the wrong database loudly at setup. A text check over YAML would be the vacuous kind of test this
  repo has been burned by; enforcement beats a source scan.
- *A second container for the tests.* It would also work, but it does not fix the guard's logic, and
  it makes the local recipe heavier for no additional safety.

## Tasks

### Task 1 — RED: the guard's contract

**Files:** `tests/dark-factory/pg-test-helpers.test.ts`

Extend `#332 reset safety rail`. The first two cases are the existing ones; the second case's
assertions are corrected by D3, and a control case is added so the suite cannot pass vacuously.

```ts
it("refuses the DSN the local launcher writes its live ledger to", () => {
  // #689: this is the exact DSN in the local run launcher. It is a live ledger, not a test database,
  // and the reset used to accept it because the host was localhost.
  expect(() =>
    assertDisposableDsn("postgres://postgres@localhost:5432/darkfactory?sslmode=disable"),
  ).toThrow(/does not look like a disposable test database/);
});

it("accepts a test database whatever the host is", () => {
  // The host is not the signal: a remote CI service container is disposable, a local ledger is not.
  expect(() => assertDisposableDsn("postgres://postgres@localhost:5432/darkfactory_test")).not.toThrow();
  expect(() => assertDisposableDsn("postgresql://u:p@db.example.com:5432/df_run_history_test")).not.toThrow();
});

it("refuses a localhost DSN whose DATABASE is not a test database", () => {
  expect(() => assertDisposableDsn("postgresql://df_test@127.0.0.1:55432/df_run_history")).toThrow(
    /does not look like a disposable test database/,
  );
});

it("refuses a DSN it cannot parse, rather than crashing", () => {
  // Fail closed: a keyword/value DSN has no URL path to read a database name from.
  expect(() => assertDisposableDsn("host=localhost port=5432")).toThrow(
    /does not look like a disposable test database/,
  );
  expect(() => assertDisposableDsn("")).toThrow(/does not look like a disposable test database/);
});
```

**Verify RED:**

```bash
npx vitest run tests/dark-factory/pg-test-helpers.test.ts
```

Expected: the two new refusal cases fail (the guard does not throw), the unparseable case fails with
a `TypeError` rather than the named error, and the acceptance case passes. Read the tally — a case
that passes in RED proves nothing.

```bash
git add tests/dark-factory/pg-test-helpers.test.ts
git commit -F "$LOCALAPPDATA/Temp/red689-msg.txt"   # test(689): RED — the reset must refuse a live ledger
```

### Task 2 — GREEN: the guard decides on the database name

**Files:** `tests/dark-factory/pg-test-helpers.ts` (the `assertDisposableDsn` function only)

```ts
/**
 * Refuse to reset anything that is not a database named as a test database.
 *
 * #689 — the previous rule accepted any localhost DSN, and the local run launcher writes its live
 * ledger to `postgres://postgres@localhost:5432/darkfactory`. The reset therefore truncated the rows
 * a real run had just recorded, which read as a store fault for several sessions. The host is not the
 * signal: a remote CI service container is disposable and a local ledger is not. The DATABASE NAME is.
 *
 * Fails closed: a DSN it cannot parse is refused, never silently accepted.
 */
export function assertDisposableDsn(connectionString: string): void {
  const refuse = (): never => {
    throw new Error(
      "refusing to reset tables: the DSN does not look like a disposable test database " +
        "(its database name must contain _test, e.g. darkfactory_test)",
    );
  };
  let database: string;
  try {
    database = decodeURIComponent(new URL(connectionString).pathname).replace(/^\/+/, "");
  } catch {
    return refuse();
  }
  if (!database.toLowerCase().includes("_test")) return refuse();
}
```

**Verify GREEN:**

```bash
npx vitest run tests/dark-factory/pg-test-helpers.test.ts
npx tsc --noEmit --incremental false
```

Expected: all cases pass; type-check exit 0.

**Then check the blast radius on the suite itself.** `pg-suite-isolation.test.ts` already uses
`postgres://postgres@localhost:5432/darkfactory_test` as its base, so it is unaffected — confirm
rather than assume:

```bash
npx vitest run tests/dark-factory/pg-suite-isolation.test.ts
```

```bash
git add tests/dark-factory/pg-test-helpers.ts
git commit -F "$LOCALAPPDATA/Temp/green689-msg.txt"  # fix(689): GREEN — ...
```

### Task 3 — point CI and the documented recipe at a test database

**Files:** `.github/workflows/ci.yml`, `AGENTS.md`, `README.md`, `.env.example`

`.github/workflows/ci.yml` — the service (line 46) and the five values (lines 61-68):

```yaml
        env:
          POSTGRES_HOST_AUTH_METHOD: trust
          POSTGRES_DB: darkfactory_test
```

```yaml
      DF_TENANT_TEST_DATABASE_URL: postgres://postgres@localhost:5432/darkfactory_test?sslmode=disable
```

…and the same for `DF_COST_BUDGET_TEST_DATABASE_URL`, `DF_RUN_HISTORY_TEST_DATABASE_URL`,
`DF_USAGE_TEST_DATABASE_URL`, `DF_CONTROL_TEST_DATABASE_URL`.

`AGENTS.md` — the coverage recipe keeps a `darkfactory` container (the launcher needs it) and adds
the test database, then exports the test variables at it:

```bash
docker run -d --rm --name df-cov-pg -p 5432:5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=darkfactory postgres:16-alpine

# The test suites write to a DATABASE NAMED AS A TEST DATABASE (#689): the reset refuses anything
# else, so that a suite can never truncate the local run ledger that lives in `darkfactory`.
docker exec df-cov-pg psql -U postgres -c 'CREATE DATABASE darkfactory_test'

export DF_TENANT_TEST_DATABASE_URL="postgres://postgres@localhost:5432/darkfactory_test?sslmode=disable"
export DF_COST_BUDGET_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_RUN_HISTORY_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_USAGE_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_CONTROL_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
```

`README.md` lines 1010 and 1110 — say "a disposable database" is a `_test` database, so the
documented contract matches the enforced one. `.env.example` lines 616-618 and 645-647 — the same
one-clause refinement on the two documented test DSNs. **`.env.example` is CRLF**; edit it with a
byte-level replace that preserves the endings, or the diff becomes the whole file.

### Task 4 — the ADR and its index row

**Files:** `docs/adr/0088-a-test-database-is-named-as-one.md` (new), `docs/adr/README.md`

Context / Decision / Consequences, following the shape of its neighbors, recording D1 and the
verified #689 evidence. Keep the slug short: the index row's label must fit the existing column
width, or the pinned `markdown-table-formatter@1.6.1` re-pads every row and the diff is pure
whitespace churn.

```bash
npx -y markdown-table-formatter@1.6.1 docs/adr/README.md
git diff --stat docs/adr/README.md
git diff -w --stat docs/adr/README.md
```

Expected: the two outputs are the same. A large difference means the formatter re-padded.

### Task 5 — prove it on this machine (the acceptance criterion)

No unit test can prove the property this issue is about, because the property is about *which
database a suite does not touch*. Prove it against the real container.

```bash
# 1. confirm the live ledger's shape, then plant a marker in it
docker exec df-cov-pg psql -U postgres -d darkfactory -c '\d df_run_summaries'

docker exec df-cov-pg psql -U postgres -d darkfactory -c \
  "insert into df_run_summaries (run_id, repo, issue, status) values ('probe-689','ricardoblackskye/WebFeedPOC',232,'blocked') returning run_id;"

# 2. run the suite against the NEW test database
export DF_TENANT_TEST_DATABASE_URL="postgres://postgres@localhost:5432/darkfactory_test?sslmode=disable"
export DF_COST_BUDGET_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_RUN_HISTORY_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_USAGE_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
export DF_CONTROL_TEST_DATABASE_URL="$DF_TENANT_TEST_DATABASE_URL"
npm run test:coverage

# 3. the marker must SURVIVE
docker exec df-cov-pg psql -U postgres -d darkfactory -t -c \
  "select count(*) from df_run_summaries where run_id='probe-689';"
```

Expected: `1`. Before this change the same sequence printed `0` — that is the whole issue. If the
insert reports a missing NOT NULL column, read step 1's output and add it; do not weaken the proof to
a table-existence check.

Also record the old behaviour on the same tree, so the fix is a measured difference rather than a
claim: point the five variables back at `darkfactory`, run the setup, and confirm it now **fails
loudly** with `refusing to reset tables: the DSN does not look like a disposable test database`.

Delete the probe row when done.

### Task 6 — the local gate

```bash
npx vitest run --exclude 'tests/env-example-coverage.test.ts'
npx tsc --noEmit --incremental false
npx -y cspell@9.1.1 --config .cspell.json --no-progress <changed files>
npx -y markdownlint-cli@0.45.0 -c "$LOCALAPPDATA/Temp/markdownlint.json" <changed .md files>
npx -y markdown-table-formatter@1.6.1 --check <changed .md files>
npx -y markdown-link-check@3.12.2 <changed .md files>
npm run coverage:ratchet
```

All six must pass before the push. Note 690: the DB suite is load-flaky with a 5-second timeout, so
a timeout under parallel load is a re-run with the four affected files isolated first, and never a
waiver. Record what was re-run and why.

## Files likely to change

| File                                                            | Change                                               |
|-----------------------------------------------------------------|------------------------------------------------------|
| `tests/dark-factory/pg-test-helpers.ts`                         | the guard decides on the database name               |
| `tests/dark-factory/pg-test-helpers.test.ts`                    | RED: refusal cases plus a corrected fixture          |
| `.github/workflows/ci.yml`                                      | `POSTGRES_DB` and the five test DSNs                 |
| `AGENTS.md`                                                     | the local recipe creates and uses `darkfactory_test` |
| `README.md`                                                     | two mentions of the test DSNs                        |
| `.env.example`                                                  | two comments (CRLF preserved)                        |
| `docs/adr/0088-a-test-database-is-named-as-one.md`              | new ADR                                              |
| `docs/adr/README.md`                                            | index row                                            |
| `.hermes/plans/2026-11-18_test-database-is-named-as-one-689.md` | this plan                                            |

No module is added under `agent/lib/`, so the doc-drift catalogue guard is not triggered.

## Risks and open questions

**Risks.**

- **CI goes red if `ci.yml` is not in the same change.** Task 3 is a hard dependency of the merge.
- **Local setups break loudly.** By design, and named in the error message. The PR body must say so,
  because the user's own gate script exports `.../darkfactory` today and will need the new value.
- **690 is not fixed here.** The Postgres suites still share one database with a 5-second timeout;
  this change moves them off the *launcher's* data, which reduces the damage but not the contention.
- **The coverage baseline was recorded against `darkfactory`.** Moving the database should not change
  which suites run, so the ratchet should hold — but if it moves, read 686 before touching the floor,
  because a floor that was recorded with the suites skipping is a different problem.

**Open questions for the reviewer.**

1. **D1's axis** — database name (recommended) versus the issue's literal DSN-wide substring? The
   substring form is a smaller diff and leaves `postgresql://df_test@prod/production` accepted.
2. **D5** — a new ADR (recommended) or an in-place `## Amendment` on 0052, which that file already has
   precedent for?
3. **The three undocumented test DSNs.** `.env.example` documents `DF_USAGE_TEST_DATABASE_URL` and
   `DF_TENANT_TEST_DATABASE_URL` but not the run-history, cost-budget or control ones. Adding them is
   a consistency fix in the same area — in or out?
4. **686's wording.** It tracks `AGENTS.md` saying "the six Postgres test variables" while listing
   five. This plan rewrites that block, so the one-word correction is nearly free — but it is 686's
   scope, so it stays out unless you want it folded in.

## Out of scope

- The launcher's own DSN and the `df:local-run` preflight. The launcher *should* accept localhost —
  it wants the local database. The two guards point in opposite directions on one host, which is
  exactly why the host was the wrong axis for the test reset.
- Any change to `agent/` production code.
- The `tests/db/migrate.integration.test.ts` DSN, which carries its own dedicated-database guard.
