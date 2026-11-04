# #593 — Close the migration-application gap with a migration runner

## Goal

Make `db/migrations/*.sql` actually reach a hosted database. Today they are committed and reviewed but nothing applies them: the adapters create tables at runtime via `ensureSchema`, and the migrations — including the only place RLS is enabled — are inert unless a human runs them by hand. That is the root cause of #591, where six tables sat public without RLS despite the commands being committed in `001`, `002`, `009` and `010`.

The durable fix is a small, tested runner: `scripts/db-migrate.ts`. It applies migrations in filename order, records what it applied in a `schema_migrations` table, and **refuses** rather than guesses when the database and the files disagree.

## Why the runner and not `ensureSchema`

`ensureSchema` is application startup code. It creates tables and (since #591) sets `security_invoker` on the view, but it deliberately does **not** enable RLS — enabling RLS with no policies would lock the app out unless the connection role bypasses it. So RLS lives only in migrations. Putting migrations behind application startup would make the security posture depend on which code path happened to run first, and would run DDL-with-policy changes at request time. The runner keeps that decision explicit and deploy-time.

## Verified current state

| Fact | Evidence |
| --- | --- |
| No runner exists | `package.json` has no migrate script; no script references `db/migrations` |
| Every migration's DDL is idempotent | Every `CREATE TABLE`/`CREATE INDEX` uses `IF NOT EXISTS`; every `ALTER TABLE` uses `IF EXISTS`; the `DO` block is guarded by `to_regclass`. Verified by grep across all 11 files |
| No `CREATE INDEX CONCURRENTLY` | Confirmed — so each file can run inside a transaction |
| No down migrations | Confirmed — nothing to reverse |
| 11 migrations, `001`–`011` | `db/migrations/` |
| Primary DSN | `DF_RUN_HISTORY_DATABASE_URL`; cost/control fall back to it. `.env.local` carries it plus tenant/usage/amm-scan DSNs |
| The #409 guard does not cover this | It scans `tests/dark-factory` only; a migration suite belongs outside that registry |

## Design decisions

1. **Version key = full filename** (`001_df_cost_budgets.sql`), not the numeric prefix. The prefix is not guaranteed unique, and a filename collision is an error worth seeing. Sort lexicographically — zero-padded prefixes make that correct.

2. **`schema_migrations` is created by the runner**, not by a migration (a migration that records migrations is circular):
   ```sql
   CREATE TABLE IF NOT EXISTS schema_migrations (
     version TEXT PRIMARY KEY,
     checksum TEXT NOT NULL,
     applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   ```

3. **Checksums are line-ending normalised.** `sha256` over the file with `\r\n` → `\n` first. Without this, the same file checked out on Windows and Linux hashes differently and a deploy reports false drift. This is the single most likely real-world failure, so it gets its own test.

4. **Each file runs in its own transaction.** `BEGIN; <file>; INSERT INTO schema_migrations …; COMMIT;` — a failed migration leaves neither partial DDL nor a false "applied" record. Advisory lock (`pg_advisory_lock`) on a dedicated client so two deploy jobs cannot race; released in `finally`.

5. **Drift refuses, never repairs.** Three states:
   - file not applied → apply it;
   - applied version missing from disk → refuse (database is ahead of the checkout);
   - checksum mismatch → refuse (the file changed after it was applied).
   No `--force` in v1. A wrong guess here is worse than a failed deploy.

6. **Default action is `--status`.** Printing the plan is safe; writing needs `--apply`. Usage error (no action, no DSN) exits 2.

7. **DSN resolution:** `--database-url` flag > `DF_MIGRATE_DATABASE_URL` > `DF_RUN_HISTORY_DATABASE_URL`. Refuse when none is set. The connection's `search_path` is honoured, so a staging schema works without special-casing; the test suite creates its own database so it lands in `public`.

8. **Exit codes:** `0` applied or up to date; `1` drift or a failed migration; `2` usage error. `--status` exits `1` when migrations are pending, so CI can gate on it.

9. **No down migrations.** Rollback is a manual operation with a review. Documented, not automated.

## Tasks — each RED first, then GREEN

### Task 1 — pure plan computation (unit)
**Files:** `scripts/db-migrate.ts`, `tests/db/migrate.test.ts`
- RED: tests for `readMigrations(dir)`, `parseApplied(rows)`, `computePlan(files, applied)` covering: lexicographic order; duplicate version detection; pending vs applied; database-ahead; checksum mismatch; CRLF/LF equivalence.
- GREEN: implement pure functions with no database access. `computePlan` returns `{ pending, drift }`, and the CLI turns `drift` into a refusal.

### Task 2 — read applied state and print status (integration)
**Files:** `scripts/db-migrate.ts`, `tests/db/migrate-postgres.test.ts`
- RED: against a disposable database, `--status` on an empty database lists all 11 as pending and exits `1`; after `CREATE TABLE schema_migrations`, it lists them as pending but creates nothing else. Assert no application tables exist after a status run.
- GREEN: create `schema_migrations` only when applying, never on a status read. Implement `--status`.

### Task 3 — apply pending migrations and record them (integration)
**Files:** `scripts/db-migrate.ts`, `tests/db/migrate-postgres.test.ts`
- RED: `--apply` on an empty disposable database applies all 11 in order, creates the Dark Factory tables, enables RLS on the tables each migration covers, and records 11 rows in `schema_migrations`. Re-running `--apply` applies nothing and exits `0`. A second `--status` exits `0`.
- GREEN: implement the apply loop with per-file transactions and the advisory lock.

### Task 4 — refuse on drift (integration)
**Files:** `scripts/db-migrate.ts`, `tests/db/migrate-postgres.test.ts`
- RED: (a) append a byte to an already-applied migration → `--apply` refuses, names the file, and changes nothing; (b) insert a row into `schema_migrations` for a version with no file → `--apply` refuses and names the missing version.
- GREEN: implement the checksum comparison and the "database ahead" check; no writes before the plan is validated.

### Task 5 — concurrency (integration)
**Files:** `tests/db/migrate-postgres.test.ts`
- RED: two `--apply` runs started together against the same empty database both exit `0`, the migrations are applied exactly once, and no duplicate rows appear in `schema_migrations`. One may report "up to date" after waiting on the lock.
- GREEN: advisory lock held for the whole run on a dedicated client.

### Task 6 — CLI surface (unit/integration)
**Files:** `scripts/db-migrate.ts`, `tests/db/migrate.test.ts`
- RED: `--help` exits `0` and documents the flags; no action exits `2`; `--apply` without a DSN exits `2` naming the variables; unknown flag exits `2`; `--database-url` overrides the env var.
- GREEN: implement argument parsing with no side effects before validation.

### Task 7 — npm script and documentation
**Files:** `package.json`, `docs/pages/dark-factory-local-runs.md` (or the deployment doc)
- RED: the script does not exist and the docs do not mention applying migrations.
- GREEN: add `"db:migrate": "tsx scripts/db-migrate.ts"`, document `npm run db:migrate -- --status`, `--apply`, the DSN resolution order, the drift refusal, and the verification queries from `011`.

### Task 8 — CI gate (optional, phase 2)
**Files:** `.github/workflows/ci.yml`
- Add a job with a `postgres:16-alpine` service that runs `--apply` against an empty database and then `--status`, proving a fresh environment reaches the remediated posture. Optional because it needs a database in CI; the integration tests already cover the behaviour.

## Acceptance criteria mapping

| AC | How it lands |
| --- | --- |
| 1 — applying migrations to a fresh database is automated or a documented ordered step | Tasks 2–4, 7: the runner applies them; the docs give the command |
| 2 — runtime DDL and migrations cannot silently diverge | Partly satisfied by `migration-rls.test.ts` (every adapter table has an `ENABLE ROW LEVEL SECURITY` command). This runner adds the database side: `--status` fails when the database is ahead or a file changed after apply |
| 3 — answer "which migrations has this database had?" without the linter | Task 2: `--status` prints applied and pending from `schema_migrations` |
| 4 — the #591 remediation is reachable by the same mechanism | `011_df_rls_remediation.sql` is one of the files; Task 3 applies it like any other |
| 5 — a fresh environment reaches the remediated posture without manual steps | Tasks 3 and 8: one command from empty to the same RLS posture |

## Risks and deviations to flag

- **Line endings.** Windows checkouts and Linux deploys will disagree on checksums unless normalised. Task 1 tests this explicitly; do not drop it as a nicety.
- **Baseline on an already-provisioned database.** Every migration is idempotent (verified), so a first run against the live database should be safe. But "should be" is not "is": the plan's integration test runs against an empty database, not against a copy of production. Before the first production run, take a snapshot and run `--status` first — it changes nothing.
- **The advisory lock is session-scoped.** It works because the runner uses one dedicated client. A pool would release the lock between queries and defeat it.
- **`CREATE DATABASE` in tests.** The integration suite creates a uniquely named database per run and drops it afterwards. It must refuse a non-disposable DSN; reuse `assertDisposableDsn` from `pg-test-helpers`.
- **Migrations are honoured, not rewritten.** If a migration has already been applied somewhere and needs a fix, add a new migration. Editing an applied file is exactly what the checksum refusal exists to catch.
- **Not in `tests/dark-factory`.** The #409 guard scans that directory and requires registration in `PG_SUITES`, whose global setup drops schemas and truncates tables. This suite needs an unmanaged database it creates and drops, so it belongs in `tests/db`.

## Out of scope

- Down/rollback migrations.
- A schema-diff engine that generates migrations from the adapters' DDL.
- Replacing `ensureSchema`; the runner complements it, it does not replace it.
- Applying migrations from application startup.
- A hosted migration service or dashboard integration.
