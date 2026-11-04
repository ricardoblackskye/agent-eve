import { Client } from "pg";
import { describe, expect, it } from "vitest";

/**
 * #591 — live-database proof for the Supabase security findings.
 *
 * The source-text guard in `migration-rls.test.ts` proves the adapter's DDL CONTAINS the option. It
 * cannot prove the option is actually set on the view in a real database — which is what the Supabase
 * linter reads. This suite asks the live catalog directly.
 *
 * READ-ONLY BY DESIGN. Every query here is a SELECT against `pg_class` or a count against the view.
 * This suite deliberately does NOT instantiate the run-history store or call `ensureSchema`, because
 * `ensureSchema` also runs `repairActiveRunDuplicates`, which UPDATEs run summaries to abort duplicate
 * ACTIVE runs. Running that against a production database could terminate real in-flight runs. The
 * adapter's DDL behaviour is proven end-to-end against a disposable database by
 * `run-history-postgres.test.ts`; this file proves the LIVE database's state.
 *
 * Gated by its own variable so the hermetic suite stays hermetic and CI never touches production.
 * Run it after applying `db/migrations/011_df_rls_remediation.sql`:
 *
 *   DF_LIVE_VIEW_SECURITY_DATABASE_URL='postgres://...' \
 *     npx vitest run tests/dark-factory/view-security-live.test.ts
 *
 * A failure here means the migration has not been applied to that database yet — which is the signal
 * #591 asks for, not a flake.
 */
const dsn = (process.env.DF_LIVE_VIEW_SECURITY_DATABASE_URL ?? "").trim();
const describeWithLiveDatabase = dsn ? describe : describe.skip;

const VIEW = "df_plan_estimate_accuracy";

/** The six tables the Supabase linter reported as public without RLS. */
const FLAGGED_TABLES = [
  "df_usage_events",
  "df_cost_reservations",
  "df_cost_budgets",
  "df_plans",
  "df_plan_estimates",
  "df_amm_scans",
] as const;

describeWithLiveDatabase("live database security posture (#591)", () => {
  it(`the live ${VIEW} view carries security_invoker = true`, async () => {
    const client = new Client({ connectionString: dsn });
    await client.connect();
    try {
      const result = await client.query<{ relname: string; reloptions: string[] | null }>(
        `select c.relname, c.reloptions
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where c.relname = $1
            and c.relkind = 'v'`,
        [VIEW],
      );

      expect(result.rows, `${VIEW} is not a view in this database`).toHaveLength(1);
      const options = result.rows[0].reloptions ?? [];
      expect(
        options,
        `${VIEW} is missing security_invoker; apply db/migrations/011_df_rls_remediation.sql`,
      ).toContain("security_invoker=true");
    } finally {
      await client.end();
    }
  });

  it("the six linter-flagged tables have RLS enabled", async () => {
    const client = new Client({ connectionString: dsn });
    await client.connect();
    try {
      const result = await client.query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where c.relname = any($1::text[])
            and c.relkind = 'r'`,
        [FLAGGED_TABLES],
      );

      // Non-vacuous: the run-history tables are created by the adapter this view belongs to, so a
      // database where they are absent is not the database this test is meant to inspect.
      expect(
        result.rows.map((row) => row.relname),
        "the run-history tables are missing: this is not the database this view belongs to",
      ).toEqual(expect.arrayContaining(["df_plans", "df_plan_estimates"]));

      // Only tables that EXIST can carry RLS. A missing table has nothing for the linter to flag,
      // so tolerate absence but refuse to pass a present table without RLS.
      const withoutRls = result.rows
        .filter((row) => !row.relrowsecurity)
        .map((row) => row.relname);
      expect(
        withoutRls,
        "RLS is not enabled on these tables; apply db/migrations/011_df_rls_remediation.sql",
      ).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it("the application's role can still read through the view", async () => {
    // A smoke read: if the view or its grants broke, this fails instead of silently returning nothing.
    // It does not assert row contents — the point is that a real connection still resolves the view.
    const client = new Client({ connectionString: dsn });
    await client.connect();
    try {
      const result = await client.query<{ n: number }>(`select count(*)::int as n from ${VIEW}`);
      expect(result.rows).toHaveLength(1);
      expect(Number(result.rows[0].n)).toBeGreaterThanOrEqual(0);
    } finally {
      await client.end();
    }
  });
});
