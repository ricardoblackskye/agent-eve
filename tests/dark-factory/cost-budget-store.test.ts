import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConsoleCostBudgetProvider,
  InMemoryCostBudgetProvider,
  createCostBudgetStore,
} from "../../agent/lib/dark-factory/cost-budget-store";
import { SqliteCostBudgetAdapter } from "../../agent/lib/dark-factory/cost-budget-store-sqlite";
import { PostgresCostBudgetAdapter } from "../../agent/lib/dark-factory/cost-budget-store-postgres";
import { CostBudgetConfigurationError } from "../../agent/lib/dark-factory/cost-budget";

const PERIOD = "2026-02";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createCostBudgetStore", () => {
  it("defaults to the fail-closed console provider", async () => {
    const store = createCostBudgetStore({});
    expect(store).toBeInstanceOf(ConsoleCostBudgetProvider);
    const read = await store.listBudgets();
    expect(read.ok).toBe(false);
    expect(read.mode).toBe("blocked");
    expect(read.error).toMatch(/not configured/i);
    const reserve = await store.reserve(PERIOD, "orchestrator", 1);
    expect(reserve.ok).toBe(false);
    expect(reserve.error).toMatch(/not configured/i);
    const settle = await store.settle("reservation-1", 1);
    expect(settle.ok).toBe(false);
    expect(settle.error).toMatch(/not configured/i);
  });

  it("creates SQLite locally and refuses it in deployed environments", () => {
    expect(
      createCostBudgetStore({ DF_COST_BUDGET_DRIVER: "sqlite", DF_COST_BUDGET_DB_PATH: ":memory:" }),
    ).toBeInstanceOf(SqliteCostBudgetAdapter);
    expect(() =>
      createCostBudgetStore({
        NODE_ENV: "production",
        DF_COST_BUDGET_DRIVER: "sqlite",
        DF_COST_BUDGET_DB_PATH: ":memory:",
      }),
    ).toThrow(CostBudgetConfigurationError);
    expect(() =>
      createCostBudgetStore({
        DF_PLATFORM_PROVIDER: "vercel",
        VERCEL_ENV: "preview",
        DF_COST_BUDGET_DRIVER: "sqlite",
        DF_COST_BUDGET_DB_PATH: ":memory:",
      }),
    ).toThrow(/local-only/i);
    expect(() => createCostBudgetStore({ DF_COST_BUDGET_DRIVER: "sqlite" })).toThrow(
      /DF_COST_BUDGET_DB_PATH/,
    );
  });

  it("creates Postgres with the dedicated URL or the run-history fallback", () => {
    expect(
      createCostBudgetStore({
        DF_COST_BUDGET_DRIVER: "postgres",
        DF_COST_BUDGET_DATABASE_URL: "postgresql://example",
      }),
    ).toBeInstanceOf(PostgresCostBudgetAdapter);
    expect(
      createCostBudgetStore({
        DF_COST_BUDGET_DRIVER: "postgres",
        DF_RUN_HISTORY_DATABASE_URL: "postgres://example",
      }),
    ).toBeInstanceOf(PostgresCostBudgetAdapter);
    expect(() => createCostBudgetStore({ DF_COST_BUDGET_DRIVER: "postgres" })).toThrow(
      CostBudgetConfigurationError,
    );
    expect(() =>
      createCostBudgetStore({
        DF_COST_BUDGET_DRIVER: "postgres",
        DF_COST_BUDGET_DATABASE_URL: "mysql://example",
      }),
    ).toThrow(/postgres:\/\//i);
  });

  it("rejects unknown drivers", () => {
    expect(() => createCostBudgetStore({ DF_COST_BUDGET_DRIVER: "memory" })).toThrow(
      CostBudgetConfigurationError,
    );
  });
});

describe("in-memory cost budget store", () => {
  it("reserves under the cap and refuses a reservation that would exceed it", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "orchestrator", 10);

    const first = await store.reserve(PERIOD, "orchestrator", 6);
    expect(first.ok).toBe(true);
    expect(first.reservationId).toBeTruthy();

    // 6 already reserved; another 5 would total 11 > 10.
    const second = await store.reserve(PERIOD, "orchestrator", 5);
    expect(second.ok).toBe(false);
    expect(second.mode).toBe("blocked");
    expect(second.error).toMatch(/exceed/i);

    // 4 still fits exactly (6 + 4 = 10).
    const third = await store.reserve(PERIOD, "orchestrator", 4);
    expect(third.ok).toBe(true);
  });

  it("charges the actual cost and releases the reservation on settle", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "pr-review", 5);

    const { reservationId } = await store.reserve(PERIOD, "pr-review", 2);
    expect(reservationId).toBeTruthy();
    await store.settle(reservationId!, 1.5);

    const [budget] = (await store.listBudgets(PERIOD)).value;
    expect(budget.spentUsd).toBe(1.5);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.callCount).toBe(1);
  });

  it("charges the reserved estimate when the provider reports no cost", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "developer", 5);

    const { reservationId } = await store.reserve(PERIOD, "developer", 2);
    await store.settle(reservationId!, null);

    const [budget] = (await store.listBudgets(PERIOD)).value;
    expect(budget.spentUsd).toBe(2);
    expect(budget.reservedUsd).toBe(0);
    expect(budget.callCount).toBe(1);
  });

  it("treats a duplicate settle as a no-op", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "tester", 5);
    const { reservationId } = await store.reserve(PERIOD, "tester", 2);

    await store.settle(reservationId!, 2);
    await store.settle(reservationId!, 2);

    const [budget] = (await store.listBudgets(PERIOD)).value;
    expect(budget.spentUsd).toBe(2);
    expect(budget.callCount).toBe(1);
  });

  it("refuses to reserve against a category with no configured budget", async () => {
    const store = new InMemoryCostBudgetProvider();
    const result = await store.reserve(PERIOD, "orchestrator", 1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no budget configured/i);
  });

  it("isolates budgets by period", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget("2026-02", "orchestrator", 10);
    await store.ensureBudget("2026-03", "orchestrator", 20);

    expect((await store.listBudgets("2026-02")).value).toHaveLength(1);
    expect((await store.listBudgets("2026-03")).value).toHaveLength(1);
    expect((await store.listBudgets()).value).toHaveLength(2);
  });
});

describe("sqlite cost budget store", () => {
  it("persists a cap, spends against it, and survives a reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "df-cost-budget-"));
    directories.push(directory);
    const path = join(directory, "cost.sqlite");

    const store = new SqliteCostBudgetAdapter(path);
    await store.ensureBudget(PERIOD, "orchestrator", 10);
    const reserved = await store.reserve(PERIOD, "orchestrator", 3);
    expect(reserved.ok).toBe(true);
    await store.settle(reserved.reservationId!, 2.25);

    const over = await store.reserve(PERIOD, "orchestrator", 9);
    expect(over.ok).toBe(false);
    store.close();

    const reopened = new SqliteCostBudgetAdapter(path);
    const [budget] = (await reopened.listBudgets(PERIOD)).value;
    expect(budget.capUsd).toBe(10);
    expect(budget.spentUsd).toBe(2.25);
    expect(budget.callCount).toBe(1);
    reopened.close();
  });

  it("refuses every operation when the file cannot be opened", async () => {
    const store = new SqliteCostBudgetAdapter(
      join(tmpdir(), `absent-${Date.now()}`, "nested", "cost.sqlite"),
    );
    const read = await store.listBudgets();
    expect(read.ok).toBe(false);
    expect(read.mode).toBe("blocked");
    const reserve = await store.reserve(PERIOD, "orchestrator", 1);
    expect(reserve.ok).toBe(false);
    expect(reserve.error).toMatch(/unreachable/i);
  });
});