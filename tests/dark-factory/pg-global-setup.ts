import { PG_TABLES, resetPgTables } from "./pg-test-helpers";

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

export default async function setup(): Promise<void> {
  const allTables = [
    ...PG_TABLES.runHistory,
    ...PG_TABLES.usage,
    ...PG_TABLES.costBudget,
    ...PG_TABLES.tenants,
    ...PG_TABLES.control,
  ];
  // Every suite may point at its own database; reset each distinct DSN once.
  const targets = new Set(
    DSN_VARS.map((name) => (process.env[name] ?? "").trim()).filter((dsn) => dsn.length > 0),
  );
  for (const dsn of targets) {
    await resetPgTables(dsn, allTables);
  }
}
