import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RLS coverage (#211).
 *
 * The Dark Factory Postgres adapters create their own tables at runtime
 * (`CREATE TABLE IF NOT EXISTS`), so the source of truth for "which tables
 * exist" is the adapter code — while RLS is enabled by a source-controlled
 * migration in `db/migrations/`. This guard cross-checks the two: every table
 * an adapter creates must have `ENABLE ROW LEVEL SECURITY` somewhere in a
 * migration.
 *
 * The four run-history tables were flagged by the Supabase database linter for
 * exactly this gap.
 */
const ROOT = process.cwd();
const LIB = join(ROOT, "agent", "lib", "dark-factory");
const MIGRATIONS = join(ROOT, "db", "migrations");

const CREATE = /CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi;
const ENABLE_RLS =
  /ALTER TABLE\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)\s+ENABLE ROW LEVEL SECURITY/gi;

function createdTables(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(LIB)) {
    if (!file.endsWith(".ts")) continue;
    const text = readFileSync(join(LIB, file), "utf8");
    for (const match of text.matchAll(CREATE)) {
      found.add(match[1].toLowerCase());
    }
  }
  return found;
}

function rlsEnabledTables(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith(".sql")) continue;
    const text = readFileSync(join(MIGRATIONS, file), "utf8");
    for (const match of text.matchAll(ENABLE_RLS)) {
      found.add(match[1].toLowerCase());
    }
  }
  return found;
}

describe("RLS coverage (#211)", () => {
  it("finds the adapter-created tables (non-vacuous)", () => {
    const created = createdTables();
    expect(created.size).toBeGreaterThan(5);
    expect(created.has("df_run_summaries")).toBe(true);
    expect(created.has("df_cost_budgets")).toBe(true);
  });

  it("every table the adapters create has RLS enabled by a migration", () => {
    const rls = rlsEnabledTables();
    const missing = [...createdTables()].filter((t) => !rls.has(t)).sort();
    expect(missing).toEqual([]);
  });

  it("covers the four run-history tables the Supabase linter flagged", () => {
    const rls = rlsEnabledTables();
    for (const table of [
      "df_run_summaries",
      "df_run_events",
      "df_run_deliveries",
      "df_run_control_receipts",
    ]) {
      expect(rls.has(table)).toBe(true);
    }
  });
});