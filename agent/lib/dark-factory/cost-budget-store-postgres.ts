/**
 * Dark Factory — PostgreSQL cost budget adapter.
 *
 * Standard `pg` only; no vendor SDK. The reserve path takes a row lock on the
 * budget so two concurrent calls cannot both be admitted past the cap. The
 * schema is also shipped as a source-controlled migration
 * (`db/migrations/001_df_cost_budgets.sql`); `ensureSchema` keeps local and
 * integration runs working without a separate migrate step.
 */

import type { Pool, PoolClient } from "pg";
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
    cap_usd DOUBLE PRECISION NOT NULL,
    spent_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    reserved_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
    call_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS df_cost_budgets_period_category_idx
    ON df_cost_budgets (period, category);
  CREATE TABLE IF NOT EXISTS df_cost_reservations (
    reservation_id TEXT PRIMARY KEY,
    budget_id TEXT NOT NULL REFERENCES df_cost_budgets(budget_id) ON DELETE CASCADE,
    estimated_usd DOUBLE PRECISION NOT NULL,
    created_at TEXT NOT NULL,
    settled BOOLEAN NOT NULL DEFAULT FALSE
  );
`;

interface BudgetRow {
  budget_id: string;
  period: string;
  category: string;
  cap_usd: number;
  spent_usd: number;
  reserved_usd: number;
  call_count: number;
}

interface ReservationRow {
  reservation_id: string;
  budget_id: string;
  estimated_usd: number;
  settled: boolean;
}

function rowToBudget(row: BudgetRow): CostBudget {
  return {
    category: row.category as CostCategory,
    period: row.period,
    capUsd: Number(row.cap_usd),
    spentUsd: Number(row.spent_usd),
    reservedUsd: Number(row.reserved_usd),
    callCount: Number(row.call_count),
  };
}

export class PostgresCostBudgetAdapter implements CostBudgetStore {
  readonly id = "postgres";
  private readonly connectionString: string;
  private poolPromise: Promise<Pool> | null = null;
  private schemaPromise: Promise<void> | null = null;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
  }

  private async pool(): Promise<Pool> {
    if (!this.poolPromise) {
      this.poolPromise = import("pg").then(
        ({ Pool }) => new Pool({ connectionString: this.connectionString, max: 2 }),
      );
    }
    return this.poolPromise;
  }

  private async ensureSchema(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool()
        .then((pool) => pool.query(SCHEMA))
        .then(() => undefined)
        .catch((error) => {
          this.schemaPromise = null;
          throw error;
        });
    }
    await this.schemaPromise;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureSchema();
    const client = await (await this.pool()).connect();
    let began = false;
    try {
      await client.query("BEGIN");
      began = true;
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private failed(error: unknown, verb: string): string {
    return `Cost budget store ${verb} failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  async listBudgets(period?: string): Promise<CostBudgetStoreReadResult> {
    try {
      await this.ensureSchema();
      const pool = await this.pool();
      const { rows } = period
        ? await pool.query<BudgetRow>(
            "SELECT budget_id, period, category, cap_usd, spent_usd, reserved_usd, call_count FROM df_cost_budgets WHERE period = $1 ORDER BY category",
            [period],
          )
        : await pool.query<BudgetRow>(
            "SELECT budget_id, period, category, cap_usd, spent_usd, reserved_usd, call_count FROM df_cost_budgets ORDER BY period, category",
          );
      return { ok: true, mode: "live", providerId: this.id, value: rows.map(rowToBudget) };
    } catch (error) {
      return { ok: false, mode: "blocked", providerId: this.id, value: [], error: this.failed(error, "read") };
    }
  }

  async ensureBudget(
    period: string,
    category: CostCategory,
    capUsd: number,
  ): Promise<CostBudgetStoreEnsureResult> {
    if (!isCostCategory(category)) {
      return { ok: false, mode: "blocked", providerId: this.id, error: "Unknown cost category." };
    }
    try {
      await this.ensureSchema();
      const pool = await this.pool();
      await pool.query(
        `INSERT INTO df_cost_budgets (budget_id, period, category, cap_usd, spent_usd, reserved_usd, call_count, updated_at)
         VALUES ($1, $2, $3, $4, 0, 0, 0, $5)
         ON CONFLICT (budget_id) DO NOTHING`,
        [costBudgetId(period, category), period, category, Math.max(0, capUsd), new Date().toISOString()],
      );
      return { ok: true, mode: "live", providerId: this.id };
    } catch (error) {
      return { ok: false, mode: "blocked", providerId: this.id, error: this.failed(error, "ensure") };
    }
  }

  async reserve(
    period: string,
    category: CostCategory,
    estimatedUsd: number,
  ): Promise<CostBudgetStoreReserveResult> {
    if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: "Reservation estimate must be a non-negative finite number.",
      };
    }
    const id = costBudgetId(period, category);
    try {
      return await this.transaction(async (client) => {
        const { rows } = await client.query<BudgetRow>(
          "SELECT budget_id, period, category, cap_usd, spent_usd, reserved_usd, call_count FROM df_cost_budgets WHERE budget_id = $1 FOR UPDATE",
          [id],
        );
        const row = rows[0];
        if (!row) {
          return {
            ok: false,
            mode: "blocked",
            providerId: this.id,
            error: `No budget configured for period '${period}' category '${category}'.`,
          };
        }
        const committed = Number(row.spent_usd) + Number(row.reserved_usd);
        if (committed + estimatedUsd > Number(row.cap_usd)) {
          return {
            ok: false,
            mode: "blocked",
            providerId: this.id,
            error: "Reservation would exceed the configured budget cap.",
          };
        }
        const reservationId = `res-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await client.query(
          "INSERT INTO df_cost_reservations (reservation_id, budget_id, estimated_usd, created_at, settled) VALUES ($1, $2, $3, $4, FALSE)",
          [reservationId, id, estimatedUsd, new Date().toISOString()],
        );
        await client.query(
          "UPDATE df_cost_budgets SET reserved_usd = reserved_usd + $1, updated_at = $2 WHERE budget_id = $3",
          [estimatedUsd, new Date().toISOString(), id],
        );
        return { ok: true, mode: "live", providerId: this.id, reservationId };
      });
    } catch (error) {
      return { ok: false, mode: "blocked", providerId: this.id, error: this.failed(error, "reserve") };
    }
  }

  async settle(
    reservationId: string,
    actualCostUsd: number | null,
  ): Promise<CostBudgetStoreSettleResult> {
    try {
      return await this.transaction(async (client) => {
        const { rows } = await client.query<ReservationRow>(
          "SELECT reservation_id, budget_id, estimated_usd, settled FROM df_cost_reservations WHERE reservation_id = $1 FOR UPDATE",
          [reservationId],
        );
        const reservation = rows[0];
        if (!reservation) {
          return { ok: false, mode: "blocked", providerId: this.id, error: "Unknown reservation." };
        }
        if (reservation.settled) {
          return { ok: true, mode: "live", providerId: this.id };
        }
        const estimated = Number(reservation.estimated_usd);
        const charged = actualCostUsd === null ? estimated : Math.max(0, actualCostUsd);
        await client.query(
          `UPDATE df_cost_budgets
             SET spent_usd = spent_usd + $1,
                 reserved_usd = GREATEST(0, reserved_usd - $2),
                 call_count = call_count + 1,
                 updated_at = $3
           WHERE budget_id = $4`,
          [charged, estimated, new Date().toISOString(), reservation.budget_id],
        );
        await client.query("UPDATE df_cost_reservations SET settled = TRUE WHERE reservation_id = $1", [
          reservationId,
        ]);
        return { ok: true, mode: "live", providerId: this.id };
      });
    } catch (error) {
      return { ok: false, mode: "blocked", providerId: this.id, error: this.failed(error, "settle") };
    }
  }

  async close(): Promise<void> {
    if (this.poolPromise) {
      const pool = await this.poolPromise;
      await pool.end();
      this.poolPromise = null;
    }
  }
}