/**
 * Cost budget cap management (follow-up to #478).
 *
 * The operator CLI `df:cost-budget` tops up a SPENT cap. It needs a store
 * primitive that changes `cap_usd` on an existing row WITHOUT disturbing the
 * spend record — `ensureBudget` only creates-if-absent, so it cannot do this.
 * The two properties that matter:
 *
 *  1. the cap changes (that is what grants headroom to the gate), and
 *  2. `spent_usd` / `reserved_usd` / `call_count` survive the write, because
 *     zeroing spend would erase the month's accounting and let the period
 *     exceed the ceiling the operator actually intends.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConsoleCostBudgetProvider,
  InMemoryCostBudgetProvider,
  type CostBudgetStore,
} from "../../agent/lib/dark-factory/cost-budget-store";
import { SqliteCostBudgetAdapter } from "../../agent/lib/dark-factory/cost-budget-store-sqlite";

const PERIOD = "2026-10";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("setBudgetCap (in-memory)", () => {
  it("creates the row when the period/category has none", async () => {
    const store = new InMemoryCostBudgetProvider();

    const result = await store.setBudgetCap(PERIOD, "orchestrator", 100);

    expect(result.ok).toBe(true);
    expect(result.value?.capUsd).toBe(100);
    const [budget] = (await store.listBudgets(PERIOD)).value;
    expect(budget!.capUsd).toBe(100);
    expect(budget!.spentUsd).toBe(0);
    expect(budget!.callCount).toBe(0);
  });

  it("changes the cap on an existing row and PRESERVES the spend record", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "orchestrator", 30);
    const { reservationId } = await store.reserve(PERIOD, "orchestrator", 5);
    await store.settle(reservationId!, 29.6);

    const result = await store.setBudgetCap(PERIOD, "orchestrator", 100);

    expect(result.ok).toBe(true);
    const [budget] = (await store.listBudgets(PERIOD)).value;
    expect(budget!.capUsd).toBe(100);
    // The whole point: raise the ceiling, keep the month's accounting.
    expect(budget!.spentUsd).toBe(29.6);
    expect(budget!.callCount).toBe(1);
  });

  it("grants real headroom: a reservation refused before the top-up is admitted after", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "orchestrator", 10);
    const first = await store.reserve(PERIOD, "orchestrator", 9);
    await store.settle(first.reservationId!, 9);

    const refused = await store.reserve(PERIOD, "orchestrator", 5);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/exceed/i);

    await store.setBudgetCap(PERIOD, "orchestrator", 100);
    const admitted = await store.reserve(PERIOD, "orchestrator", 5);
    expect(admitted.ok).toBe(true);
  });

  it("rejects a negative cap without writing", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.ensureBudget(PERIOD, "orchestrator", 30);

    const result = await store.setBudgetCap(PERIOD, "orchestrator", -1);

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("blocked");
    const [budget] = (await store.listBudgets(PERIOD)).value;
    expect(budget!.capUsd).toBe(30);
  });

  it("rejects a non-finite cap without writing", async () => {
    const store = new InMemoryCostBudgetProvider();

    const result = await store.setBudgetCap(PERIOD, "orchestrator", Number.NaN);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/finite/i);
  });

  it("rejects an unknown category without writing", async () => {
    const store = new InMemoryCostBudgetProvider();

    // Bypass the type to model an untyped CLI argument.
    const result = await store.setBudgetCap(PERIOD, "nope" as never, 10);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/category/i);
  });

  it("keeps a tenant-scoped cap separate from the global budget", async () => {
    const store = new InMemoryCostBudgetProvider();
    await store.setBudgetCap(PERIOD, "orchestrator", 30);

    const scoped = await store.setBudgetCap(
      PERIOD,
      "orchestrator",
      5,
      "tenant-1",
    );

    expect(scoped.ok).toBe(true);
    expect((await store.listBudgets(PERIOD)).value[0]!.capUsd).toBe(30);
    const [tenantRow] = (await store.listTenantBudgets("tenant-1", PERIOD))
      .value;
    expect(tenantRow!.capUsd).toBe(5);
  });

  it("is fail-closed on the console provider", async () => {
    const store: CostBudgetStore = new ConsoleCostBudgetProvider();

    const result = await store.setBudgetCap(PERIOD, "orchestrator", 100);

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("blocked");
    expect(result.error).toMatch(/not configured/i);
  });
});

describe("setBudgetCap (sqlite)", () => {
  it("creates, then tops up, preserving spend across a reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "df-cost-set-cap-"));
    directories.push(directory);
    const path = join(directory, "cost.sqlite");

    const store = new SqliteCostBudgetAdapter(path);
    expect((await store.setBudgetCap(PERIOD, "orchestrator", 30)).ok).toBe(
      true,
    );
    const { reservationId } = await store.reserve(PERIOD, "orchestrator", 5);
    await store.settle(reservationId!, 29.6);

    expect((await store.setBudgetCap(PERIOD, "orchestrator", 100)).ok).toBe(
      true,
    );
    store.close();

    const reopened = new SqliteCostBudgetAdapter(path);
    const [budget] = (await reopened.listBudgets(PERIOD)).value;
    expect(budget!.capUsd).toBe(100);
    expect(budget!.spentUsd).toBe(29.6);
    reopened.close();
  });

  it("rejects a negative cap without writing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "df-cost-set-cap-"));
    directories.push(directory);
    const store = new SqliteCostBudgetAdapter(join(directory, "cost.sqlite"));

    const result = await store.setBudgetCap(PERIOD, "orchestrator", -0.5);

    expect(result.ok).toBe(false);
    expect((await store.listBudgets(PERIOD)).value).toHaveLength(0);
    store.close();
  });
});
