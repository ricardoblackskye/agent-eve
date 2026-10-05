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
import { DatabaseSync } from "node:sqlite";
import { Client } from "pg";
import type { TenantStore } from "../agent/lib/dark-factory/tenant-store";
import { createTenantStore } from "../agent/lib/dark-factory/tenant-store-provider";
import type { UsageStore } from "../agent/lib/dark-factory/usage-store";
import { createUsageStore } from "../agent/lib/dark-factory/usage-store-provider";
import {
  toUsageEvent,
  type UsageEvent,
} from "../agent/lib/dark-factory/usage-ledger";
import type { CostBudgetStore } from "../agent/lib/dark-factory/cost-budget-store";
import { createCostBudgetStore } from "../agent/lib/dark-factory/cost-budget-store";
import type { CostCategory } from "../agent/lib/dark-factory/cost-budget";
import type { RunHistoryStore } from "../agent/lib/dark-factory/run-history-store";
import { createRunHistoryStore } from "../agent/lib/dark-factory/run-history-provider";
import type { RunStatus } from "../agent/lib/dark-factory/run-history";
import type { ControlStore } from "../agent/lib/dark-factory/control";
import { createControlStore } from "../agent/lib/dark-factory/control";
import type { MembershipStore } from "../agent/lib/dark-factory/membership-store";
import { createMembershipStore } from "../agent/lib/dark-factory/membership-store";
import type { MembershipInput } from "../agent/lib/dark-factory/membership";
import { loadLocalEnv } from "./load-env";

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
  membership: MembershipStore;
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
  { ok: true; report: SeedReport } | { ok: false; error: string };

/** A fixed instant so re-runs produce byte-identical data. */
const SEED_TS = "2026-01-15T09:00:00.000Z";
const SEED_PERIOD = "2026-01";
const SEED_BUDGET_PERIOD = "2026-02";
const SEED_MODEL = "deepseek/deepseek-chat";
const SEED_ACTOR = "seed:test-data";

const USAGE = `Usage: tsx scripts/seed-test-data.ts (--all | --scenario=<name> ...) \\
  [--reset] [--dry-run]
Scenarios: ${SCENARIOS.join(", ")}`;

export function parseArgs(argv: string[]): SeedOptions | { error: string } {
  const scenarios: ScenarioName[] = [];
  let reset = false;
  let dryRun = false;
  let all = false;

  for (const arg of argv) {
    if (arg === "--reset") {
      reset = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    const match = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!match) {
      return { error: `Unrecognised argument '${arg}'. Expected --key=value.` };
    }
    const key = match[1] ?? "";
    const value = match[2] ?? "";
    if (key !== "scenario") {
      return { error: `Unknown option '--${key}'.` };
    }
    if (!(SCENARIOS as readonly string[]).includes(value)) {
      return {
        error: `Unknown scenario '${value}'. Known scenarios: ${SCENARIOS.join(", ")}.`,
      };
    }
    scenarios.push(value as ScenarioName);
  }

  const chosen = all ? [...SCENARIOS] : [...new Set(scenarios)];
  if (chosen.length === 0) {
    return { error: "Provide at least one --scenario=<name> or --all." };
  }
  return {
    scenarios: chosen,
    ...(reset ? { reset: true } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  };
}

export function buildStores(
  env: Record<string, string | undefined> = process.env,
): SeedStores {
  return {
    tenant: createTenantStore(env),
    usage: createUsageStore(env),
    cost: createCostBudgetStore(env),
    runHistory: createRunHistoryStore(env),
    control: createControlStore(env),
    membership: createMembershipStore(env),
  };
}

// ---------------------------------------------------------------------------
// Store helpers — all idempotent.
// ---------------------------------------------------------------------------

async function ensureTenant(
  store: TenantStore,
  slug: string,
  name: string,
): Promise<string> {
  const res = await store.upsertTenant({ slug, name });
  if (!res.ok) throw new Error(`upsertTenant(${slug}) failed: ${res.error}`);
  return res.value.id;
}

async function ensureRepo(
  store: TenantStore,
  repo: string,
  tenantId: string,
): Promise<void> {
  const res = await store.assignRepo(repo, tenantId);
  if (!res.ok) throw new Error(`assignRepo(${repo}) failed: ${res.error}`);
}

interface RunSeedInput {
  deliveryId: string;
  repo: string;
  issue: number;
  tenantId?: string;
  status?: RunStatus;
}

/**
 * Accept a run and, when it is not `queued`, move it to the requested status
 * with the single event that transition needs. Returns `created: false` on a
 * re-run (the delivery id is the idempotency key), so callers seed dependent
 * rows (usage) only once.
 */
async function ensureRun(
  store: RunHistoryStore,
  input: RunSeedInput,
): Promise<{ runId: string; created: boolean }> {
  const accepted = await store.acceptDelivery({
    deliveryId: input.deliveryId,
    repo: input.repo,
    issue: input.issue,
    receivedAt: SEED_TS,
    ...(input.tenantId ? { tenantId: input.tenantId } : {}),
  });
  if (!accepted.ok) {
    throw new Error(
      `acceptDelivery(${input.deliveryId}) failed: ${accepted.error}`,
    );
  }
  const runId = accepted.value?.runId ?? "";
  const created = accepted.duplicate !== true;

  const status = input.status ?? "queued";
  if (status !== "queued" && created) {
    const transition =
      status === "running"
        ? {
            type: "dispatch.started" as const,
            stage: "dispatch" as const,
            status,
          }
        : status === "blocked"
          ? {
              type: "worker.question" as const,
              stage: "worker" as const,
              status,
            }
          : {
              type: "run.terminal" as const,
              stage: "terminal" as const,
              status,
            };
    const event = await store.appendEvent({
      eventId: `${input.deliveryId}-${status}`,
      runId,
      type: transition.type,
      stage: transition.stage,
      occurredAt: SEED_TS,
      status: transition.status,
    });
    if (!event.ok) {
      throw new Error(
        `appendEvent(${input.deliveryId}) failed: ${event.error}`,
      );
    }
  }
  return { runId, created };
}

async function seedUsage(
  store: UsageStore,
  events: UsageEvent[],
): Promise<void> {
  for (const event of events) {
    const res = await store.record(event);
    if (!res.ok)
      throw new Error(`usage.record failed: ${res.error ?? "unknown"}`);
  }
}

async function ensureBudget(
  store: CostBudgetStore,
  period: string,
  category: CostCategory,
  capUsd: number,
): Promise<void> {
  const res = await store.ensureBudget(period, category, capUsd);
  if (!res.ok)
    throw new Error(
      `ensureBudget(${category}) failed: ${res.error ?? "unknown"}`,
    );
}

/** Idempotent: a membership that already exists is left exactly as it is. */
async function ensureMember(
  store: MembershipStore,
  input: MembershipInput,
): Promise<boolean> {
  const existing = await store.getMembership(input.email);
  if (!existing.ok) {
    throw new Error(`getMembership(${input.email}) failed: ${existing.error}`);
  }
  if (existing.value) return false;
  const written = await store.upsertMembership(input);
  if (!written.ok) {
    throw new Error(
      `upsertMembership(${input.email}) failed: ${written.error}`,
    );
  }
  return true;
}

async function measuredUsage(
  store: UsageStore,
  runId: string,
  tenantId: string | undefined,
  overrides: Partial<UsageEvent> = {},
): Promise<void> {
  await seedUsage(store, [
    toUsageEvent({
      runId,
      taskType: "orchestrator",
      model: SEED_MODEL,
      tokensIn: 1200,
      tokensOut: 480,
      costUsd: 0.00026,
      durationMs: 1500,
      ts: SEED_TS,
      ...(tenantId ? { tenantId } : {}),
      ...overrides,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// Scenarios — each returns whether it wrote anything new.
// ---------------------------------------------------------------------------

async function scenarioHappyPath(s: SeedStores): Promise<boolean> {
  const tenantId = await ensureTenant(
    s.tenant,
    "seed-happy",
    "Seed Happy Path",
  );
  await ensureRepo(s.tenant, "seed-org/happy-repo", tenantId);

  const ok = await ensureRun(s.runHistory, {
    deliveryId: "seed-happy-1",
    repo: "seed-org/happy-repo",
    issue: 101,
    tenantId,
    status: "succeeded",
  });
  const failed = await ensureRun(s.runHistory, {
    deliveryId: "seed-happy-2",
    repo: "seed-org/happy-repo",
    issue: 102,
    tenantId,
    status: "failed",
  });
  if (ok.created) await measuredUsage(s.usage, ok.runId, tenantId);
  if (failed.created) await measuredUsage(s.usage, failed.runId, tenantId);

  await ensureBudget(s.cost, SEED_PERIOD, "orchestrator", 50);
  await ensureBudget(s.cost, SEED_PERIOD, "developer", 100);
  return ok.created || failed.created;
}

async function scenarioMultiTenant(s: SeedStores): Promise<boolean> {
  const tenants: Array<[string, string, string]> = [
    ["seed-alpha", "Seed Alpha", "seed-org/alpha"],
    ["seed-beta", "Seed Beta", "seed-org/beta"],
    ["seed-gamma", "Seed Gamma", "seed-org/gamma"],
  ];
  let created = false;
  // One unscoped operator, so the operator-only surfaces have a caller.
  if (
    await ensureMember(s.membership, {
      email: "seed-operator@example.com",
      role: "operator",
    })
  ) {
    created = true;
  }
  for (const [slug, name, repo] of tenants) {
    const tenantId = await ensureTenant(s.tenant, slug, name);
    await ensureRepo(s.tenant, repo, tenantId);
    // A customer membership per tenant, so the role and tenant-scope paths have
    // data to exercise (#215).
    if (
      await ensureMember(s.membership, {
        email: `${slug}@example.com`,
        role: "customer",
        tenantId,
      })
    ) {
      created = true;
    }
    const run = await ensureRun(s.runHistory, {
      deliveryId: `seed-${slug}-1`,
      repo,
      issue: 1,
      tenantId,
      status: "succeeded",
    });
    if (run.created) {
      await measuredUsage(s.usage, run.runId, tenantId);
      created = true;
    }
  }
  return created;
}

async function scenarioUnassigned(s: SeedStores): Promise<boolean> {
  const run = await ensureRun(s.runHistory, {
    deliveryId: "seed-unassigned-1",
    repo: "seed-org/unassigned",
    issue: 1,
    status: "succeeded",
  });
  if (run.created) {
    // No tenantId: the genuine UNASSIGNED bucket, distinct from any customer.
    await measuredUsage(s.usage, run.runId, undefined);
  }
  return run.created;
}

async function scenarioUnmeasured(s: SeedStores): Promise<boolean> {
  const run = await ensureRun(s.runHistory, {
    deliveryId: "seed-unmeasured-1",
    repo: "seed-org/unmeasured",
    issue: 1,
    status: "succeeded",
  });
  if (run.created) {
    // Only the required fields: NO tokens/cost/duration, so the row is
    // UNMEASURED rather than measured-zero.
    await seedUsage(s.usage, [
      toUsageEvent({
        runId: run.runId,
        taskType: "orchestrator",
        model: SEED_MODEL,
        ts: SEED_TS,
      }),
    ]);
  }
  return run.created;
}

async function scenarioOverBudget(s: SeedStores): Promise<boolean> {
  const cap = 10;
  await ensureBudget(s.cost, SEED_BUDGET_PERIOD, "tester", cap);
  const budgets = await s.cost.listBudgets(SEED_BUDGET_PERIOD);
  if (!budgets.ok)
    throw new Error(`listBudgets failed: ${budgets.error ?? "unknown"}`);
  const existing = budgets.value.find((b) => b.category === "tester");
  if ((existing?.reservedUsd ?? 0) > 0) return false; // already reserved

  const reserved = await s.cost.reserve(SEED_BUDGET_PERIOD, "tester", cap);
  if (!reserved.ok) {
    throw new Error(`reserve(tester) failed: ${reserved.error ?? "unknown"}`);
  }
  return true;
}

async function scenarioMixedStatus(s: SeedStores): Promise<boolean> {
  const statuses: RunStatus[] = [
    "queued",
    "running",
    "blocked",
    "succeeded",
    "failed",
    "aborted",
  ];
  let created = false;
  for (const [index, status] of statuses.entries()) {
    const run = await ensureRun(s.runHistory, {
      deliveryId: `seed-mixed-${status}`,
      repo: "seed-org/mixed",
      issue: 200 + index,
      status,
    });
    if (run.created) created = true;
  }
  return created;
}

async function scenarioControl(s: SeedStores): Promise<boolean> {
  const factory = await s.control.writeFactory({
    paused: true,
    updatedAt: SEED_TS,
    actor: SEED_ACTOR,
    reason: "test data",
  });
  if (!factory.ok)
    throw new Error(`writeFactory failed: ${factory.error ?? "unknown"}`);

  const run = await s.control.writeRun("seed-run-control", {
    paused: true,
    stopped: false,
    updatedAt: SEED_TS,
    actor: SEED_ACTOR,
    reason: "test data",
  });
  if (!run.ok) throw new Error(`writeRun failed: ${run.error ?? "unknown"}`);

  const events = await s.control.listEvents(500);
  const already = events.ok
    ? (events.value ?? []).some((e) => e.actor === SEED_ACTOR)
    : false;
  if (!already) {
    const appended = await s.control.appendEvent({
      at: SEED_TS,
      actor: SEED_ACTOR,
      action: "pause",
      scope: "factory",
      reason: "test data",
    });
    if (!appended.ok) {
      throw new Error(
        `appendEvent(control) failed: ${appended.error ?? "unknown"}`,
      );
    }
    return true;
  }
  return false;
}

async function scenarioEmpty(): Promise<boolean> {
  // Intentionally writes nothing — the empty-state fixture.
  return false;
}

const SCENARIO_FNS: Record<ScenarioName, (s: SeedStores) => Promise<boolean>> =
  {
    "happy-path": scenarioHappyPath,
    "multi-tenant": scenarioMultiTenant,
    unassigned: scenarioUnassigned,
    unmeasured: scenarioUnmeasured,
    "over-budget": scenarioOverBudget,
    "mixed-status": scenarioMixedStatus,
    control: scenarioControl,
    empty: scenarioEmpty,
  };

export async function runSeed(
  stores: SeedStores,
  options: SeedOptions,
): Promise<SeedResult> {
  const outcomes: ScenarioOutcome[] = [];
  for (const name of options.scenarios) {
    if (options.dryRun) {
      outcomes.push({ name, applied: false, skipped: false });
      continue;
    }
    try {
      const applied = await SCENARIO_FNS[name](stores);
      outcomes.push({ name, applied, skipped: !applied });
    } catch (error) {
      return {
        ok: false,
        error: `scenario '${name}' failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  return {
    ok: true,
    report: {
      outcomes,
      reset: options.reset === true,
      dryRun: options.dryRun === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Reset — FAIL-CLOSED, table-level, guarded against production.
// ---------------------------------------------------------------------------

const STORE_TABLES: Record<keyof SeedStores, string[]> = {
  tenant: ["df_tenants", "df_tenant_repos"],
  usage: ["df_usage_events"],
  cost: ["df_cost_budgets", "df_cost_reservations"],
  runHistory: [
    "df_run_control_receipts",
    "df_run_deliveries",
    "df_run_events",
    "df_run_summaries",
  ],
  control: ["df_control_events", "df_run_control", "df_factory_control"],
  membership: ["df_tenant_members"],
};

interface ResetTarget {
  driver: string;
  sqlitePath?: string;
  connectionString?: string;
}

function resetTargets(
  env: Record<string, string | undefined>,
): Record<keyof SeedStores, ResetTarget> {
  const fallback = (env.DF_RUN_HISTORY_DATABASE_URL ?? "").trim();
  return {
    tenant: {
      driver: (env.DF_TENANT_DRIVER ?? "").trim().toLowerCase(),
      sqlitePath: (env.DF_TENANT_DB_PATH ?? "").trim() || undefined,
      connectionString: (env.DF_TENANT_DATABASE_URL ?? "").trim() || undefined,
    },
    usage: {
      driver: (env.DF_USAGE_DRIVER ?? "").trim().toLowerCase(),
      sqlitePath: (env.DF_USAGE_DB_PATH ?? "").trim() || undefined,
      connectionString: (env.DF_USAGE_DATABASE_URL ?? "").trim() || undefined,
    },
    cost: {
      driver: (env.DF_COST_BUDGET_DRIVER ?? "").trim().toLowerCase(),
      sqlitePath: (env.DF_COST_BUDGET_DB_PATH ?? "").trim() || undefined,
      connectionString:
        (env.DF_COST_BUDGET_DATABASE_URL ?? "").trim() || fallback || undefined,
    },
    runHistory: {
      driver: (env.DF_RUN_HISTORY_DRIVER ?? "").trim().toLowerCase(),
      sqlitePath: (env.DF_RUN_HISTORY_DB_PATH ?? "").trim() || undefined,
      connectionString: fallback || undefined,
    },
    control: {
      driver: (env.DF_CONTROL_DRIVER ?? "").trim().toLowerCase(),
      sqlitePath: (env.DF_CONTROL_DB_PATH ?? "").trim() || undefined,
      connectionString:
        (env.DF_CONTROL_DATABASE_URL ?? "").trim() || fallback || undefined,
    },
    membership: {
      driver: (env.DF_MEMBERSHIP_DRIVER ?? "").trim().toLowerCase(),
      sqlitePath: (env.DF_MEMBERSHIP_DATABASE_PATH ?? "").trim() || undefined,
      connectionString:
        (env.DF_MEMBERSHIP_DATABASE_URL ?? "").trim() || fallback || undefined,
    },
  };
}

function isDeployedRuntime(env: Record<string, string | undefined>): boolean {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") return true;
  const provider = (env.DF_PLATFORM_PROVIDER ?? "").trim().toLowerCase();
  const stage = (provider === "vercel" ? env.VERCEL_ENV : env.DF_DEPLOYMENT_ENV)
    ?.trim()
    .toLowerCase();
  return stage === "preview" || stage === "production";
}

function deleteSqlite(path: string, tables: string[]): number {
  const db = new DatabaseSync(path);
  let cleared = 0;
  try {
    for (const table of tables) {
      try {
        const result = db.prepare(`DELETE FROM ${table}`).run();
        cleared += Number(result.changes ?? 0);
      } catch {
        // Table does not exist yet — nothing to clear.
      }
    }
  } finally {
    db.close();
  }
  return cleared;
}

async function deletePostgres(
  connectionString: string,
  tables: string[],
): Promise<number> {
  const client = new Client({ connectionString });
  let cleared = 0;
  try {
    await client.connect();
    for (const table of tables) {
      try {
        const result = await client.query(`DELETE FROM ${table}`);
        cleared += result.rowCount ?? 0;
      } catch {
        // Table does not exist yet — nothing to clear.
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
  return cleared;
}

export async function resetTestData(
  env: Record<string, string | undefined> = process.env,
): Promise<SeedResult> {
  if (isDeployedRuntime(env)) {
    return {
      ok: false,
      error:
        "Refusing to reset test data in a deployed/production runtime (NODE_ENV=production or a preview/production stage).",
    };
  }

  const targets = resetTargets(env);
  const outcomes: ScenarioOutcome[] = [];
  for (const key of Object.keys(STORE_TABLES) as Array<keyof SeedStores>) {
    const target = targets[key];
    const tables = STORE_TABLES[key];
    try {
      if (target.driver === "sqlite" && target.sqlitePath) {
        deleteSqlite(target.sqlitePath, tables);
      } else if (target.driver === "postgres" && target.connectionString) {
        await deletePostgres(target.connectionString, tables);
      }
      // console / memory / unset: nothing external to clear.
      outcomes.push({ name: "empty", applied: true, skipped: false });
    } catch (error) {
      return {
        ok: false,
        error: `reset failed for '${key}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
  return { ok: true, report: { outcomes, reset: true, dryRun: false } };
}

async function main(): Promise<number> {
  // The app reads .env.local; a bare tsx run would not, so without this the
  // seed and the app can disagree about which store — and which database — is
  // in play. Shell-exported values still win.
  loadLocalEnv();

  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`seed-test-data: ${parsed.error}`);
    console.error(USAGE);
    return 1;
  }

  if (parsed.reset) {
    const reset = await resetTestData(process.env);
    if (!reset.ok) {
      console.error(`seed-test-data: ${reset.error}`);
      return 1;
    }
    console.log("reset: cleared Dark Factory test tables.");
  }

  const stores = buildStores(process.env);
  try {
    const result = await runSeed(stores, parsed);
    if (!result.ok) {
      console.error(`seed-test-data: ${result.error}`);
      return 1;
    }
    for (const outcome of result.report.outcomes) {
      const label = outcome.applied
        ? "applied"
        : outcome.skipped
          ? "already present"
          : "no-op";
      console.log(`  ${outcome.name}: ${label}`);
    }
    console.log(
      `${result.report.dryRun ? "[dry run] " : ""}done — ${result.report.outcomes.length} scenario(s).`,
    );
    return 0;
  } finally {
    stores.tenant.close?.();
    await stores.usage.close();
    stores.cost.close?.();
    await stores.runHistory.close();
    await stores.control.close?.();
    await stores.membership.close?.();
  }
}

const entry = (process.argv[1] ?? "").replace(/\\/g, "/");
if (entry.endsWith("scripts/seed-test-data.ts")) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
