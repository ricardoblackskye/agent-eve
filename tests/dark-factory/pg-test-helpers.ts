import { Client } from "pg";

/**
 * #332 — hermetic Postgres test suites.
 *
 * The five Postgres-backed suites share one database and never reset it, so rows accumulate across
 * runs and aggregate-style assertions flake purely because of leftovers. Each suite owns DISTINCT
 * tables, so a suite resetting only its own is sufficient and cannot disturb a neighbour.
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

/** Row counts for the given tables — the raw evidence behind a hermetic-start assertion. */
export async function pgRowCounts(
  connectionString: string,
  tables: readonly string[],
): Promise<Record<string, number>> {
  return withClient(connectionString, async (client) => {
    const counts: Record<string, number> = {};
    for (const table of tables) {
      if (!IDENTIFIER.test(table)) throw new Error(`unsafe table identifier: ${table}`);
      const result = await client.query<{ n: number }>(
        `select count(*)::int as n from "${table}"`,
      );
      counts[table] = result.rows[0]?.n ?? 0;
    }
    return counts;
  });
}

/** Reset a suite's OWN tables so it starts from the same state on every run (#332). */
export async function resetPgTables(
  connectionString: string,
  tables: readonly string[],
): Promise<void> {
  assertDisposableDsn(connectionString);
  await withClient(connectionString, async (client) => {
    for (const table of tables) {
      if (!IDENTIFIER.test(table)) throw new Error(`unsafe table identifier: ${table}`);
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
