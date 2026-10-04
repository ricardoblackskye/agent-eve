/**
 * Dark Factory — comprehensive test-data seed (#250).
 *
 * Populates EVERY Dark Factory store with deterministic, re-runnable test data
 * for local/dev and the Postgres test project, plus a fail-closed `--reset`.
 *
 * It drives the store/provider layer only (never raw SQL for inserts), so it
 * behaves identically on sqlite and postgres and cannot violate a store
 * invariant: unmeasured values stay absent (never zero), tenant attribution is
 * write-once, and tenant ids stay opaque.
 *
 * Determinism: fixed ids and fixed timestamps, so a re-run is an idempotent
 * no-op that reports what it found.
 *
 * Usage:
 *   tsx scripts/seed-test-data.ts --all
 *   tsx scripts/seed-test-data.ts --scenario=happy-path --scenario=unmeasured
 *   tsx scripts/seed-test-data.ts --all --reset --dry-run
 */
import type { TenantStore } from "../agent/lib/dark-factory/tenant-store";
import type { UsageStore } from "../agent/lib/dark-factory/usage-store";
import type { CostBudgetStore } from "../agent/lib/dark-factory/cost-budget-store";
import type { RunHistoryStore } from "../agent/lib/dark-factory/run-history-store";
import type { ControlStore } from "../agent/lib/dark-factory/control";

export const SCENARIOS = [
  "happy-path",
  "multi-tenant",
  "unassigned",
  "unmeasured",
  "over-budget",
  "mixed-status",
  "control",
  "empty",
] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

export interface SeedStores {
  tenant: TenantStore;
  usage: UsageStore;
  cost: CostBudgetStore;
  runHistory: RunHistoryStore;
  control: ControlStore;
}

export interface SeedOptions {
  scenarios: ScenarioName[];
  reset?: boolean;
  dryRun?: boolean;
}

export interface ScenarioOutcome {
  name: ScenarioName;
  /** True when this run wrote (or would write) the scenario's data. */
  applied: boolean;
  /** True when the scenario was already present and skipped. */
  skipped: boolean;
}

export interface SeedReport {
  outcomes: ScenarioOutcome[];
  reset: boolean;
  dryRun: boolean;
}

export type SeedResult =
  | { ok: true; report: SeedReport }
  | { ok: false; error: string };

export function parseArgs(_argv: string[]): SeedOptions | { error: string } {
  throw new Error("not implemented");
}

export function buildStores(
  _env: Record<string, string | undefined> = process.env,
): SeedStores {
  throw new Error("not implemented");
}

export async function resetTestData(
  _env: Record<string, string | undefined>,
): Promise<SeedResult> {
  throw new Error("not implemented");
}

export async function runSeed(
  _stores: SeedStores,
  _options: SeedOptions,
): Promise<SeedResult> {
  throw new Error("not implemented");
}