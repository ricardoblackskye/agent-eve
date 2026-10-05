import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PostgresCostBudgetAdapter } from "../../agent/lib/dark-factory/cost-budget-store-postgres";

/**
 * Integration tests run only when a disposable test database is provided:
 *   DF_COST_BUDGET_TEST_DATABASE_URL=postgresql://...
 * They are skipped (not failed) without it, matching the run-history pattern.
 * Never point this at a production database.
 */
const databaseUrl = process.env.DF_COST_BUDGET_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

integration("Postgres cost budget store (integration)", () => {
  it("reserves, settles, and enforces the cap against a real database", async () => {
    // Namespace the period so repeated runs against a shared container do not
    // collide on the same budget row.
    const period = `test-${randomUUID().slice(0, 8)}`;
    const store = new PostgresCostBudgetAdapter(databaseUrl!);
    try {
      await store.ensureBudget(period, "orchestrator", 10);

      const reserved = await store.reserve(period, "orchestrator", 4);
      expect(reserved.ok).toBe(true);
      expect(reserved.reservationId).toBeTruthy();

      // 4 reserved; another 7 would exceed the 10 cap.
      const over = await store.reserve(period, "orchestrator", 7);
      expect(over.ok).toBe(false);
      expect(over.error).toMatch(/exceed/i);

      await store.settle(reserved.reservationId!, 3.5);

      const [budget] = (await store.listBudgets(period)).value;
      expect(budget.capUsd).toBe(10);
      expect(budget.spentUsd).toBe(3.5);
      expect(budget.reservedUsd).toBe(0);
      expect(budget.callCount).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("charges the reserved estimate when no actual cost is reported", async () => {
    const period = `test-${randomUUID().slice(0, 8)}`;
    const store = new PostgresCostBudgetAdapter(databaseUrl!);
    try {
      await store.ensureBudget(period, "pr-review", 5);
      const reserved = await store.reserve(period, "pr-review", 2);
      await store.settle(reserved.reservationId!, null);

      const [budget] = (await store.listBudgets(period)).value;
      expect(budget.spentUsd).toBe(2);
      expect(budget.callCount).toBe(1);
    } finally {
      await store.close();
    }
  });

  it("provisions a tenant budget and reserves/settles it on Postgres", async () => {
    const period = `tenant-${randomUUID().slice(0, 8)}`;
    const tenantId = `tenant-int-${randomUUID().slice(0, 8)}`;
    const store = new PostgresCostBudgetAdapter(databaseUrl!);
    try {
      const ensured = await store.ensureBudget(period, "orchestrator", 10, tenantId);
      expect(ensured.ok).toBe(true);

      const reserved = await store.reserve(period, "orchestrator", 0.001, tenantId);
      expect(reserved.ok).toBe(true);
      if (!reserved.ok) return;

      const settled = await store.settle(reserved.reservationId!, 0.0005);
      expect(settled.ok).toBe(true);

      const [budget] = (await store.listTenantBudgets(tenantId, period)).value;
      expect(budget.capUsd).toBe(10);
      expect(budget.spentUsd).toBeCloseTo(0.0005);
      expect(budget.reservedUsd).toBeCloseTo(0); // reconciled away on settle
    } finally {
      await store.close();
    }
  });

  it("takes a row lock so concurrent tenant reservations cannot oversubscribe the cap", async () => {
    // Cap 0.1, each reservation 0.02 => exactly 5 fit. Fire 12 concurrently:
    // without the FOR UPDATE row lock a read-modify-write race would admit more.
    const period = `conc-${randomUUID().slice(0, 8)}`;
    const tenantId = `tenant-conc-${randomUUID().slice(0, 8)}`;
    const store = new PostgresCostBudgetAdapter(databaseUrl!);
    try {
      const ensured = await store.ensureBudget(period, "pr-review", 0.1, tenantId);
      expect(ensured.ok).toBe(true);

      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          store.reserve(period, "pr-review", 0.02, tenantId),
        ),
      );
      const admitted = results.filter((result) => result.ok).length;
      expect(admitted).toBe(5);

      for (const result of results) {
        if (result.ok) await store.settle(result.reservationId!, 0.02);
      }
    } finally {
      await store.close();
    }
  });
});