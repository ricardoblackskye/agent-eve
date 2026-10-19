import { PG_TABLES, PG_SUITES, resetPgTables, testDsnFor } from "./pg-test-helpers";
import { Client } from "pg";

/**
 * #332 — one-shot hermetic reset for the Postgres suites.
 *
 * Test FILES run in parallel and share one database, and the tables are not per-suite: run-history
 * tables are used by run-history-postgres, active-run-claim and migration-rls; usage tables by the
 * usage suites. A per-file truncate therefore races another file's in-flight test.
 *
 * Resetting ONCE, here, before any test file starts is race-free, and it clears the leftovers from a
 * previous run that made aggregate assertions flake. It mirrors CI, which starts from a fresh
 * database — the only difference is that we do it on the developer's machine too.
 *
 * `resetPgTables` re-counts after truncating and throws if anything remains, so this setup also
 * proves its own effect rather than trusting it.
 */
const DSN_VARS = [
  "DF_RUN_HISTORY_TEST_DATABASE_URL",
  "DF_USAGE_TEST_DATABASE_URL",
  "DF_COST_BUDGET_TEST_DATABASE_URL",
  "DF_TENANT_TEST_DATABASE_URL",
  "DF_CONTROL_TEST_DATABASE_URL",
] as const;

/**
 * #392 — create each suite's own schema before any worker starts.
 *
 * The one-shot reset above cannot isolate suites that share a DSN *and its tables*, which is why parallel workers
 * interfered. Each suite now owns a schema; recreating it here gives the suite a clean, private set of tables and
 * removes the race by construction. It also means CI's fresh database is bootstrapped explicitly, so a missing
 * schema fails HERE, loudly, instead of surfacing as a mysterious write failure inside an unrelated assertion.
 */
async function createSuiteSchemas(dsn: string, schemas: readonly string[]): Promise<void> {
  const client = new Client({ connectionString: dsn });
  await client.connect();
  try {
    for (const schema of schemas) {
      // The name is validated by schemaForSuite (it becomes an identifier), so this cannot be injected.
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.query(`CREATE SCHEMA "${schema}"`);
    }
  } finally {
    await client.end();
  }
}

export default async function setup(): Promise<void> {
  const allTables = [
    ...PG_TABLES.runHistory,
    ...PG_TABLES.usage,
    ...PG_TABLES.costBudget,
    ...PG_TABLES.tenants,
    ...PG_TABLES.control,
  ];

  // #392: a schema per suite, on the DSN that suite actually uses.
  for (const dsnVar of DSN_VARS) {
    const base = (process.env[dsnVar] ?? "").trim();
    if (base === "") continue;
    const suites = PG_SUITES.filter((s) => s.dsnVar === dsnVar);
    if (suites.length === 0) continue;
    for (const suite of suites) {
      await createSuiteSchemas(testDsnFor(base, suite.schema.replace(/^df_test_/, "")), [suite.schema]);
    }
  }

  // Every suite may point at its own database; reset each distinct DSN once. Suites that own a schema are covered
  // above (their tables live in it), so this covers anything still using the default schema — and proves its own
  // effect rather than trusting it.
  const targets = new Set(
    DSN_VARS.map((name) => (process.env[name] ?? "").trim()).filter((dsn) => dsn.length > 0),
  );
  for (const dsn of targets) {
    await resetPgTables(dsn, allTables);
  }
}
