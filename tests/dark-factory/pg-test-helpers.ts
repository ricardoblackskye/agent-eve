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
