/**
 * Dark Factory — SQLite cost budget adapter (local/test only).
 *
 * Uses `node:sqlite` with `BEGIN IMMEDIATE` so the read-check-write of a
 * reservation is atomic against a concurrent writer. Rejected in deployed
 * environments by the factory (see `createCostBudgetStore`).
 *
 * Tenant dimension (#229): `tenant_id` is NULL for the global budget and set
 * for a tenant's; the two never share a row.
 */

import { DatabaseSync } from "node:sqlite";
import {
  type CostBudget,
  type CostCategory,
  isCostCategory,
} from "./cost-budget";
import {
  type CostBudgetStore,
  type CostBudgetStoreEnsureResult,
  type CostBudgetStoreReadResult,
  type CostBudgetStoreReserveResult,
  type CostBudgetStoreSettleResult,
  costBudgetId,
} from "./cost-budget-store";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS df_cost_budgets (
    budget_id TEXT PRIMARY KEY,
    period TEXT NOT NULL,
    category TEXT NOT NULL,
    tenant_id TEXT,
    cap_usd REAL NOT NULL,
    spent_usd REAL NOT NULL DEFAULT 0,
    reserved_usd REAL NOT NULL DEFAULT 0,
    call_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS df_cost_budgets_tenant_idx
    ON df_cost_budgets (tenant_id, period, category);
  CREATE TABLE IF NOT EXISTS df_cost_reservations (
    reservation_id TEXT PRIMARY KEY,
    budget_id TEXT NOT NULL REFERENCES df_cost_budgets(budget_id) ON DELETE CASCADE,
    estimated_usd REAL NOT NULL,
    created_at TEXT NOT NULL,
    settled INTEGER NOT NULL DEFAULT 0
  );
`;

const COLUMNS =
  "budget_id, period, category, tenant_id, cap_usd, spent_usd, reserved_usd, call_count";

interface BudgetRow {
  budget_id: string;
  period: string;
  category: string;
  tenant_id: string | null;
  cap_usd: number;
  spent_usd: number;
  reserved_usd: number;
  call_count: number;
}

interface ReservationRow {
  reservation_id: string;
  budget_id: string;
  estimated_usd: number;
  settled: number;
}

function rowToBudget(row: BudgetRow): CostBudget {
  return {
    category: row.category as CostCategory,
    period: row.period,
    capUsd: Number(row.cap_usd),
    spentUsd: Number(row.spent_usd),
    reservedUsd: Number(row.reserved_usd),
    callCount: Number(row.call_count),
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
  };
}

export class SqliteCostBudgetAdapter implements CostBudgetStore {
  readonly id = "sqlite";
  private db: DatabaseSync | null = null;
  private openError: string | null = null;

  constructor(private readonly path: string) {}

  private handle(): DatabaseSync | null {
    if (this.db) return this.db;
    if (this.openError) return null;
    try {
      const db = new DatabaseSync(this.path);
      db.exec(SCHEMA);
      this.db = db;
      return db;
    } catch (error) {
      this.openError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  private detail(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /** The GLOBAL (tenant-less) budgets. Tenant rows are never included. */
  async listBudgets(period?: string): Promise<CostBudgetStoreReadResult> {
    const db = this.handle();
    if (!db) {
      return { ok: false, mode: "blocked", providerId: this.id, value: [], error: `Cost budget store unreachable: ${this.openError}` };
    }
    try {
      const rows = (
        period
          ? db
              .prepare(
                `SELECT ${COLUMNS} FROM df_cost_budgets WHERE tenant_id IS NULL AND period = ? ORDER BY category`,
              )
              .all(period)
          : db
              .prepare(
                `SELECT ${COLUMNS} FROM df_cost_budgets WHERE tenant_id IS NULL ORDER BY period, category`,
              )
              .all()
      ) as unknown as BudgetRow[];
      return { ok: true, mode: "live", providerId: this.id, value: rows.map(rowToBudget) };
    } catch (error) {
      return { ok: false, mode: "blocked", providerId: this.id, value: [], error: `Cost budget store read failed: ${this.detail(error)}` };
    }
  }

  async listTenantBudgets(
    tenantId: string,
    period?: string,
  ): Promise<CostBudgetStoreReadResult> {
    const db = this.handle();
    if (!db) {
      return { ok: false, mode: "blocked", providerId: this.id, value: [], error: `Cost budget store unreachable: ${this.openError}` };
    }
    try {
      const rows = (
        period
          ? db
              .prepare(
                `SELECT ${COLUMNS} FROM df_cost_budgets WHERE tenant_id = ? AND period = ? ORDER BY category`,
              )
              .all(tenantId, period)
          : db
              .prepare(
                `SELECT ${COLUMNS} FROM df_cost_budgets WHERE tenant_id = ? ORDER BY period, category`,
              )
              .all(tenantId)
      ) as unknown as BudgetRow[];
      return { ok: true, mode: "live", providerId: this.id, value: rows.map(rowToBudget) };
    } catch (error) {
      return { ok: false, mode: "blocked", providerId: this.id, value: [], error: `Cost budget store read failed: ${this.detail(error)}` };
    }
  }

  async ensureBudget(
    period: string,
    category: CostCategory,
    capUsd: number,
    tenantId?: string,
  ): Promise<CostBudgetStoreEnsureResult> {
    if (!isCostCategory(category)) {
      return { ok: false, mode: "blocked", providerId: this.id, error: "Unknown cost category." };
    }
    const db = this.handle();
    if (!db) {
      return { ok: false, mode: "blocked", providerId: this.id, error: `Cost budget store unreachable: ${this.openError}` };
    }
    try {
      db.prepare(
        `INSERT INTO df_cost_budgets (budget_id, period, category, tenant_id, cap_usd, spent_usd, reserved_usd, call_count, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?)
         ON CONFLICT (budget_id) DO NOTHING`,
      ).run(
        costBudgetId(period, category, tenantId),
        period,
        category,
        tenantId ?? null,
        Math.max(0, capUsd),
        new Date().toISOString(),
      );
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) {
      return { ok: false, mode: "blocked", providerId: this.id, error: `Cost budget store ensure failed: ${this.detail(error)}` };
    }
  }

  async reserve(
    period: string,
    category: CostCategory,
    estimatedUsd: number,
    tenantId?: string,
  ): Promise<CostBudgetStoreReserveResult> {
    if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: "Reservation estimate must be a non-negative finite number.",
      };
    }
    const db = this.handle();
    if (!db) {
      return { ok: false, mode: "blocked", providerId: this.id, error: `Cost budget store unreachable: ${this.openError}` };
    }
    const id = costBudgetId(period, category, tenantId);
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db
        .prepare(`SELECT ${COLUMNS} FROM df_cost_budgets WHERE budget_id = ?`)
        .get(id) as BudgetRow | undefined;
      if (!row) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          mode: "blocked",
          providerId: this.id,
          error: `No budget configured for period '${period}' category '${category}'.`,
        };
      }
      const committed = Number(row.spent_usd) + Number(row.reserved_usd);
      if (committed + estimatedUsd > Number(row.cap_usd)) {
        db.exec("ROLLBACK");
        return {
          ok: false,
          mode: "blocked",
          providerId: this.id,
          error: "Reservation would exceed the configured budget cap.",
        };
      }
      const reservationId = `res-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      db.prepare(
        "INSERT INTO df_cost_reservations (reservation_id, budget_id, estimated_usd, created_at, settled) VALUES (?, ?, ?, ?, 0)",
      ).run(reservationId, id, estimatedUsd, new Date().toISOString());
      db.prepare(
        "UPDATE df_cost_budgets SET reserved_usd = reserved_usd + ?, updated_at = ? WHERE budget_id = ?",
      ).run(estimatedUsd, new Date().toISOString(), id);
      db.exec("COMMIT");
      return { ok: true, mode: "live", providerId: this.id, reservationId };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Transaction already closed.
      }
      return { ok: false, mode: "blocked", providerId: this.id, error: `Cost budget store reserve failed: ${this.detail(error)}` };
    }
  }

  async settle(
    reservationId: string,
    actualCostUsd: number | null,
  ): Promise<CostBudgetStoreSettleResult> {
    const db = this.handle();
    if (!db) {
      return { ok: false, mode: "blocked", providerId: this.id, error: `Cost budget store unreachable: ${this.openError}` };
    }
    try {
      db.exec("BEGIN IMMEDIATE");
      const reservation = db
        .prepare(
          "SELECT reservation_id, budget_id, estimated_usd, settled FROM df_cost_reservations WHERE reservation_id = ?",
        )
        .get(reservationId) as ReservationRow | undefined;
      if (!reservation) {
        db.exec("ROLLBACK");
        return { ok: false, mode: "blocked", providerId: this.id, error: "Unknown reservation." };
      }
      if (reservation.settled === 1) {
        db.exec("COMMIT");
        return { ok: true, mode: "live", providerId: this.id };
      }
      const estimated = Number(reservation.estimated_usd);
      const charged = actualCostUsd === null ? estimated : Math.max(0, actualCostUsd);
      db.prepare(
        `UPDATE df_cost_budgets
           SET spent_usd = spent_usd + ?,
               reserved_usd = MAX(0, reserved_usd - ?),
               call_count = call_count + 1,
               updated_at = ?
         WHERE budget_id = ?`,
      ).run(charged, estimated, new Date().toISOString(), reservation.budget_id);
      db.prepare("UPDATE df_cost_reservations SET settled = 1 WHERE reservation_id = ?").run(reservationId);
      db.exec("COMMIT");
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Transaction already closed.
      }
      return { ok: false, mode: "blocked", providerId: this.id, error: `Cost budget store settle failed: ${this.detail(error)}` };
    }
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}