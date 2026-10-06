/**
 * Test-data seed (#250).
 *
 * The properties that matter: the seed is DETERMINISTIC and IDEMPOTENT (a
 * re-run writes nothing new), it covers EVERY store, it exercises the honesty
 * invariants (unmeasured is absent, unassigned is its own bucket), and its
 * `--reset` is FAIL-CLOSED (refuses under NODE_ENV=production).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTenantStore } from "../../agent/lib/dark-factory/tenant-store";
import { InMemoryUsageStore } from "../../agent/lib/dark-factory/usage-store";
import { InMemoryCostBudgetProvider } from "../../agent/lib/dark-factory/cost-budget-store";
import { SqliteRunHistoryStore } from "../../agent/lib/dark-factory/run-history-store";
import { createControlStore } from "../../agent/lib/dark-factory/control";
import { InMemoryMembershipProvider } from "../../agent/lib/dark-factory/membership-store";
import {
  SCENARIOS,
  parseArgs,
  runSeed,
  resetTestData,
  buildStores,
  type SeedStores,
} from "../../scripts/seed-test-data";

let dir: string;
let stores: SeedStores;

function closeStores(s: SeedStores): void {
  s.tenant.close?.();
  s.usage.close();
  s.cost.close?.();
  s.runHistory.close();
  s.control.close?.();
  s.membership.close?.();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "df-seed-"));
  stores = {
    tenant: new InMemoryTenantStore(),
    usage: new InMemoryUsageStore(),
    cost: new InMemoryCostBudgetProvider(),
    runHistory: new SqliteRunHistoryStore(join(dir, "runs.sqlite")),
    control: createControlStore({
      DF_CONTROL_DRIVER: "sqlite",
      DF_CONTROL_DB_PATH: join(dir, "control.sqlite"),
    }),
    membership: new InMemoryMembershipProvider(),
  };
});

afterEach(() => {
  closeStores(stores);
  rmSync(dir, { recursive: true, force: true });
});

async function snapshot(): Promise<Record<string, number>> {
  const tenants = await stores.tenant.listTenants();
  const assignments = await stores.tenant.listRepoAssignments();
  const runs = await stores.runHistory.listRuns({ limit: 100 });
  const usage = await stores.usage.aggregate({});
  const budgets = await stores.cost.listBudgets();
  return {
    tenants: tenants.ok ? tenants.value.length : -1,
    assignments: assignments.ok ? assignments.value.length : -1,
    runs: runs.ok ? (runs.value?.items.length ?? -1) : -1,
    calls: usage.ok ? (usage.value?.totals.calls ?? -1) : -1,
    budgets: budgets.ok ? budgets.value.length : -1,
  };
}

describe("parseArgs", () => {
  it("requires at least one --scenario or --all", () => {
    const parsed = parseArgs([]);
    expect("error" in parsed && parsed.error).toMatch(/scenario|--all/);
  });

  it("collects repeated scenarios and the flags", () => {
    expect(
      parseArgs([
        "--scenario=happy-path",
        "--scenario=unmeasured",
        "--reset",
        "--dry-run",
      ]),
    ).toEqual({
      scenarios: ["happy-path", "unmeasured"],
      reset: true,
      dryRun: true,
    });
  });

  it("--all selects every scenario", () => {
    expect(parseArgs(["--all"])).toEqual({ scenarios: [...SCENARIOS] });
  });

  it("rejects an unknown scenario and unknown options", () => {
    const bad = parseArgs(["--scenario=nope"]);
    expect("error" in bad && bad.error).toMatch(/nope/);
    const opt = parseArgs(["--nope=1"]);
    expect("error" in opt && opt.error).toMatch(/nope/);
  });
});

describe("runSeed scenarios", () => {
  it("happy-path seeds a tenant, assignment, runs, usage and budgets", async () => {
    const res = await runSeed(stores, { scenarios: ["happy-path"] });
    expect(res.ok).toBe(true);

    const tenants = await stores.tenant.listTenants();
    expect(tenants.ok && tenants.value.length).toBeGreaterThan(0);
    const assignments = await stores.tenant.listRepoAssignments();
    expect(assignments.ok && assignments.value.length).toBeGreaterThan(0);
    const runs = await stores.runHistory.listRuns({ limit: 50 });
    expect(runs.ok && (runs.value?.items.length ?? 0)).toBeGreaterThan(0);
    const usage = await stores.usage.aggregate({});
    expect(usage.ok && (usage.value?.totals.calls ?? 0)).toBeGreaterThan(0);
    const budgets = await stores.cost.listBudgets("2026-01");
    expect(budgets.ok && budgets.value.length).toBeGreaterThan(0);
  });

  it("unassigned seeds usage carrying no tenant (its own bucket)", async () => {
    await runSeed(stores, { scenarios: ["unassigned"] });
    const usage = await stores.usage.aggregate({});
    expect(usage.ok && (usage.value?.unassigned.calls ?? 0)).toBeGreaterThan(0);
    expect(usage.ok && usage.value?.byTenant).toEqual([]);
  });

  it("unmeasured seeds usage carrying no measurement at all", async () => {
    await runSeed(stores, { scenarios: ["unmeasured"] });
    const usage = await stores.usage.aggregate({});
    expect(usage.ok && (usage.value?.unmeasured ?? 0)).toBeGreaterThan(0);
    expect(usage.ok && usage.value?.totals.tokensIn).toBeUndefined();
    expect(usage.ok && usage.value?.totals.costUsd).toBeUndefined();
  });

  it("over-budget leaves an open reservation against the cap", async () => {
    await runSeed(stores, { scenarios: ["over-budget"] });
    const budgets = await stores.cost.listBudgets("2026-02");
    expect(budgets.ok).toBe(true);
    const reserved = budgets.ok
      ? budgets.value.reduce((n, b) => n + (b.reservedUsd ?? 0), 0)
      : 0;
    expect(reserved).toBeGreaterThan(0);
  });

  it("mixed-status seeds a run for every canonical status", async () => {
    await runSeed(stores, { scenarios: ["mixed-status"] });
    const metrics = await stores.runHistory.getRunMetrics({});
    expect(metrics.ok).toBe(true);
    const counts = metrics.ok ? (metrics.value?.statusCounts ?? []) : [];
    expect(counts.length).toBeGreaterThan(0);
    for (const c of counts) expect(c.count).toBeGreaterThan(0);
  });

  it("control pauses the factory", async () => {
    await runSeed(stores, { scenarios: ["control"] });
    const factory = await stores.control.readFactory();
    expect(factory.ok && factory.value?.paused).toBe(true);
  });

  it("is idempotent: a second run adds nothing", async () => {
    await runSeed(stores, {
      scenarios: ["happy-path", "unassigned", "over-budget"],
    });
    const before = await snapshot();
    await runSeed(stores, {
      scenarios: ["happy-path", "unassigned", "over-budget"],
    });
    const after = await snapshot();
    expect(after).toEqual(before);
  });

  it("happy-path seeds a run with the details the Run Details page shows", async () => {
    await runSeed(stores, { scenarios: ["happy-path"] });
    const listed = await stores.runHistory.listRuns({ limit: 100 });
    expect(listed.ok).toBe(true);
    const run = listed.value?.items?.find(
      (r) => r.repo === "seed-org/happy-repo",
    );
    expect(run).toBeTruthy();
    const summary = await stores.runHistory.getRun(run?.runId ?? "");
    expect(summary?.ok).toBe(true);
    const s = summary?.value;
    expect(s?.startedAt).toBeDefined(); // Started
    expect(s?.completedAt).toBeDefined(); // Elapsed = completedAt - startedAt
    expect(s?.attemptCount).toBeGreaterThan(0); // Attempts
    expect(s?.reviewCount).toBeGreaterThan(0); // Review round
    expect(s?.iterationCount).toBeGreaterThan(0); // Iterations
    expect(s?.fixCycleCount).toBeGreaterThan(0); // Fix cycles
    expect(s?.costUsd).toBeDefined(); // Measured cost (£)
    expect(s?.latencyMs).toBeDefined(); // Latency
    expect(s?.prUrl).toBeDefined(); // PR link
  });
});

describe("resetTestData", () => {
  it("refuses when NODE_ENV=production (fail-closed)", async () => {
    const res = await resetTestData({
      NODE_ENV: "production",
      DF_TENANT_DRIVER: "sqlite",
      DF_TENANT_DB_PATH: "irrelevant.sqlite",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/production/i);
  });

  it("clears the configured sqlite tables when allowed", async () => {
    const d = mkdtempSync(join(tmpdir(), "df-reset-"));
    const env: Record<string, string> = {
      NODE_ENV: "test",
      DF_TENANT_DRIVER: "sqlite",
      DF_TENANT_DB_PATH: join(d, "tenant.sqlite"),
      DF_USAGE_DRIVER: "sqlite",
      DF_USAGE_DB_PATH: join(d, "usage.sqlite"),
      DF_COST_BUDGET_DRIVER: "sqlite",
      DF_COST_BUDGET_DB_PATH: join(d, "cost.sqlite"),
      DF_RUN_HISTORY_DRIVER: "sqlite",
      DF_RUN_HISTORY_DB_PATH: join(d, "runs.sqlite"),
      DF_CONTROL_DRIVER: "sqlite",
      DF_CONTROL_DB_PATH: join(d, "control.sqlite"),
    };
    const first = buildStores(env);
    await runSeed(first, { scenarios: ["happy-path"] });
    const before = await first.tenant.listTenants();
    expect(before.ok && before.value.length).toBeGreaterThan(0);
    closeStores(first);

    const res = await resetTestData(env);
    expect(res.ok).toBe(true);

    const second = buildStores(env);
    const after = await second.tenant.listTenants();
    expect(after.ok && after.value).toEqual([]);
    const runs = await second.runHistory.listRuns({ limit: 50 });
    expect(runs.ok && (runs.value?.items.length ?? -1)).toBe(0);
    closeStores(second);
    rmSync(d, { recursive: true, force: true });
  });
});
