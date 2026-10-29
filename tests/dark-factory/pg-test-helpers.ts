import { Client } from "pg";

/**
 * #332 — hermetic Postgres test suites.
 *
 * The five Postgres-backed suites share one database and never reset it, so rows accumulate across
 * runs and aggregate-style assertions flake purely because of leftovers. Each suite owns DISTINCT
 * tables, so a suite resetting only its own is sufficient and cannot disturb an adjacent suite.
 *
 * The reset tolerates tables that do not exist YET. CI starts from a fresh `postgres:16-alpine`
 * with no schema at all: the stores create their tables lazily on first use, and these suites run
 * their `beforeAll` reset before any store has run. A brand-new database has nothing to reset, so
 * skipping an absent table is correct — and it is what keeps this hermetic on CI as well as locally.
 */
export const PG_TABLES = {
  runHistory: ["df_run_summaries", "df_run_events", "df_run_deliveries"],
  usage: ["df_usage_events"],
  costBudget: ["df_cost_budgets", "df_cost_reservations"],
  tenants: ["df_tenants", "df_tenant_repos"],
  control: [
    "df_control_events",
    "df_run_control",
    "df_run_control_receipts",
    "df_factory_control",
  ],
} as const;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(table: string): void {
  if (!IDENTIFIER.test(table)) throw new Error(`unsafe table identifier: ${table}`);
}

/**
 * Refuse to reset anything that does not look like a disposable test database.
 *
 * This module issues destructive SQL. If a DSN ever points at something real, the right outcome is a
 * loud failure, not a quietly emptied table.
 */
export function assertDisposableDsn(connectionString: string): void {
  const lowered = connectionString.toLowerCase();
  const disposable =
    lowered.includes("_test") ||
    lowered.includes("localhost") ||
    lowered.includes("127.0.0.1");
  if (!disposable) {
    throw new Error(
      "refusing to reset tables: the DSN does not look like a disposable test database",
    );
  }
}

async function withClient<T>(
  connectionString: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Does this table exist yet? On a fresh database the stores have not created it, and a suite must
 * not treat "not created yet" as a failure.
 */
export async function pgTableExists(client: Client, table: string): Promise<boolean> {
  assertIdentifier(table);
  const result = await client.query<{ present: number }>(
    `select 1 as present from information_schema.tables
       where table_schema = current_schema() and table_name = $1 limit 1`,
    [table],
  );
  return result.rows.length > 0;
}

/** True when every named table exists. */
export async function pgTablesExist(
  connectionString: string,
  tables: readonly string[],
): Promise<boolean> {
  return withClient(connectionString, async (client) => {
    for (const table of tables) {
      if (!(await pgTableExists(client, table))) return false;
    }
    return true;
  });
}

/**
 * Row counts for the given tables — the raw evidence behind a hermetic-start assertion.
 * A table that does not exist holds no rows, so it counts as 0 rather than throwing.
 */
export async function pgRowCounts(
  connectionString: string,
  tables: readonly string[],
): Promise<Record<string, number>> {
  return withClient(connectionString, async (client) => {
    const counts: Record<string, number> = {};
    for (const table of tables) {
      if (!(await pgTableExists(client, table))) {
        counts[table] = 0;
        continue;
      }
      const result = await client.query<{ n: number }>(
        `select count(*)::int as n from "${table}"`,
      );
      counts[table] = result.rows[0]?.n ?? 0;
    }
    return counts;
  });
}

/**
 * #392 — one SCHEMA per suite, derived from the DSN the operator already sets.
 *
 * Three suites share the run-history DSN *and its tables*, so per-row cleanup cannot isolate them: one suite's
 * in-flight run still contends with another's against the shared partial UNIQUE claim index. Giving each suite its
 * own schema makes isolation a property of the fixture instead of a discipline each suite must remember.
 */
const SUITE_NAME = /^[a-z0-9_]+$/;
const SCHEMA_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** The schema a suite owns. Refuses anything that is not a plain identifier: it becomes a SQL identifier AND a DSN. */
export function schemaForSuite(suite: string): string {
  if (!SUITE_NAME.test(suite)) {
    throw new Error(
      `unsafe schema identifier for suite '${suite}': use lowercase letters, digits and underscores`,
    );
  }
  const schema = `df_test_${suite}`;
  if (!SCHEMA_IDENTIFIER.test(schema)) throw new Error(`unsafe schema identifier: ${schema}`);
  return schema;
}

/**
 * The DSN a suite should use: the operator's, plus PostgreSQL's `search_path` option.
 *
 * Two ways this must fail LOUDLY rather than guess, because quietly pointing a suite at the wrong database looks
 * like a product bug: a DSN form it does not understand, and a suite name that is not a safe identifier.
 */
export function testDsnFor(baseDsn: string, suite: string): string {
  const trimmed = (baseDsn ?? "").trim();
  if (trimmed === "") {
    throw new Error("the Postgres test DSN is empty: set the DF_*_TEST_DATABASE_URL variable");
  }
  const schema = schemaForSuite(suite);

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      "this Postgres test DSN form is not understood: expected a postgres:// URL",
    );
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error(`this Postgres test DSN form is not understood: scheme '${url.protocol}'`);
  }

  const existing = (url.searchParams.get("options") ?? "").trim();
  const searchPath = `-c search_path=${schema}`;
  url.searchParams.set("options", existing === "" ? searchPath : `${existing} ${searchPath}`);

  // `+` is a space to URLSearchParams but NOT to the connection-string parser (it percent-decodes only), so a
  // path set with `+` would arrive as the literal `-c+search_path=...` and silently leave the suite in `public`.
  return url.toString().replace(/\+/g, "%20");
}

/** The pg suites, by the file that owns them. Each owns a DISTINCT schema — the point of the exercise. */
export const PG_SUITES = [
  { file: "active-run-claim.test.ts", dsnVar: "DF_RUN_HISTORY_TEST_DATABASE_URL", schema: "df_test_active_run_claim" },
  { file: "retire-run-claim.test.ts", dsnVar: "DF_RUN_HISTORY_TEST_DATABASE_URL", schema: "df_test_retire_run_claim" },
  { file: "run-history-postgres.test.ts", dsnVar: "DF_RUN_HISTORY_TEST_DATABASE_URL", schema: "df_test_run_history_postgres" },
  { file: "cost-budget-store-postgres.test.ts", dsnVar: "DF_COST_BUDGET_TEST_DATABASE_URL", schema: "df_test_cost_budget_store_postgres" },
  { file: "tenant-store-postgres.test.ts", dsnVar: "DF_TENANT_TEST_DATABASE_URL", schema: "df_test_tenant_store_postgres" },
  { file: "usage-store-postgres.test.ts", dsnVar: "DF_USAGE_TEST_DATABASE_URL", schema: "df_test_usage_store_postgres" },
  { file: "control-postgres.test.ts", dsnVar: "DF_CONTROL_TEST_DATABASE_URL", schema: "df_test_control" },
  // #424: the AMM driver owns its own schema. It reuses the run-history DSN because the CI unit job sets five DSNs and
  // a suite that wants its own namespace takes a schema - the same arrangement active-run-claim.test.ts uses (#392).
  { file: "amm-scan-postgres.test.ts", dsnVar: "DF_RUN_HISTORY_TEST_DATABASE_URL", schema: "df_test_amm_scan_postgres" },
  { file: "record-run-cost.test.ts", dsnVar: "DF_RUN_HISTORY_TEST_DATABASE_URL", schema: "df_test_run_cost_record" },
] as const;

/**
 * Reset a suite's OWN tables so it starts from the same state on every run (#332).
 * Absent tables are skipped — a brand-new database has nothing to reset.
 */
export async function resetPgTables(
  connectionString: string,
  tables: readonly string[],
): Promise<void> {
  assertDisposableDsn(connectionString);
  await withClient(connectionString, async (client) => {
    for (const table of tables) {
      if (!(await pgTableExists(client, table))) continue;
      await client.query(`TRUNCATE TABLE "${table}" RESTART IDENTITY CASCADE`);
    }

    // Verify the effect rather than trusting it: a reset that silently failed would leave the
    // suite flaking exactly as before, and "it stopped flaking" has to be provable.
    const remaining = await pgRowCounts(connectionString, tables);
    const dirty = Object.entries(remaining).filter(([, n]) => n !== 0);
    if (dirty.length > 0) {
      throw new Error(
        `reset did not empty: ${dirty.map(([table, n]) => `${table}=${n}`).join(", ")}`,
      );
    }
  });
}
