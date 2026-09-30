/**
 * Dark Factory — provider-neutral LLM cost budget store seam.
 *
 * Persists per-(period, category) hard caps plus spent/reserved accumulators.
 * The reserve -> settle model is what makes a HARD cap possible: a call's
 * maximum estimated cost is reserved before it starts, then reconciled to the
 * actual cost afterwards. Two backends are provided (Postgres, SQLite) plus a
 * fail-closed `console` default and an in-memory provider for tests.
 *
 * Only cost/count/category/model/timestamp are stored — never prompts or
 * completions.
 */

import {
  type CostBudget,
  type CostCategory,
  CostBudgetConfigurationError,
} from "./cost-budget";
import { PostgresCostBudgetAdapter } from "./cost-budget-store-postgres";
import { SqliteCostBudgetAdapter } from "./cost-budget-store-sqlite";

export type CostBudgetStoreMode = "live" | "blocked";

export interface CostBudgetStoreReadResult {
  ok: boolean;
  mode: CostBudgetStoreMode;
  providerId: string;
  value: CostBudget[];
  error?: string;
}

export interface CostBudgetStoreEnsureResult {
  ok: boolean;
  mode: CostBudgetStoreMode;
  providerId: string;
  error?: string;
}

export interface CostBudgetStoreReserveResult {
  ok: boolean;
  mode: CostBudgetStoreMode;
  providerId: string;
  /** Present only when the reservation was admitted. */
  reservationId?: string;
  error?: string;
}

export interface CostBudgetStoreSettleResult {
  ok: boolean;
  mode: CostBudgetStoreMode;
  providerId: string;
  error?: string;
}

export interface CostBudgetStore {
  readonly id: string;
  /** All budgets, or just those for one period (`YYYY-MM`). */
  listBudgets(period?: string): Promise<CostBudgetStoreReadResult>;
  /** Create the cap row if absent; an existing row is left untouched. */
  ensureBudget(
    period: string,
    category: CostCategory,
    capUsd: number,
  ): Promise<CostBudgetStoreEnsureResult>;
  /**
   * Atomically admit a call against `capUsd` or refuse it. On success the
   * estimate is added to the reserved accumulator.
   */
  reserve(
    period: string,
    category: CostCategory,
    estimatedUsd: number,
  ): Promise<CostBudgetStoreReserveResult>;
  /**
   * Reconcile a reservation with the actual cost. A `null` actual means the
   * provider did not report a cost: the reserved estimate is charged instead of
   * releasing the reservation as though the call were free.
   */
  settle(
    reservationId: string,
    actualCostUsd: number | null,
  ): Promise<CostBudgetStoreSettleResult>;
  close?(): void | Promise<void>;
}

const NOT_CONFIGURED =
  "LLM cost budget store is not configured; refusing to govern spend.";

export class ConsoleCostBudgetProvider implements CostBudgetStore {
  readonly id = "console";

  async listBudgets(): Promise<CostBudgetStoreReadResult> {
    return { ok: false, mode: "blocked", providerId: this.id, value: [], error: NOT_CONFIGURED };
  }

  async ensureBudget(): Promise<CostBudgetStoreEnsureResult> {
    return { ok: false, mode: "blocked", providerId: this.id, error: NOT_CONFIGURED };
  }

  async reserve(): Promise<CostBudgetStoreReserveResult> {
    return { ok: false, mode: "blocked", providerId: this.id, error: NOT_CONFIGURED };
  }

  async settle(): Promise<CostBudgetStoreSettleResult> {
    return { ok: false, mode: "blocked", providerId: this.id, error: NOT_CONFIGURED };
  }
}

/** `period|category`, the primary key of a budget row. */
export function costBudgetId(period: string, category: CostCategory): string {
  return `${period}|${category}`;
}

interface Reservation {
  period: string;
  category: CostCategory;
  estimatedUsd: number;
  settled: boolean;
}

export class InMemoryCostBudgetProvider implements CostBudgetStore {
  readonly id = "memory";

  private readonly budgets = new Map<string, CostBudget>();
  private readonly reservations = new Map<string, Reservation>();

  async listBudgets(period?: string): Promise<CostBudgetStoreReadResult> {
    const value = [...this.budgets.values()]
      .filter((budget) => period === undefined || budget.period === period)
      .map((budget) => ({ ...budget }));
    return { ok: true, mode: "live", providerId: this.id, value };
  }

  async ensureBudget(
    period: string,
    category: CostCategory,
    capUsd: number,
  ): Promise<CostBudgetStoreEnsureResult> {
    const id = costBudgetId(period, category);
    if (!this.budgets.has(id)) {
      this.budgets.set(id, {
        category,
        period,
        capUsd: Math.max(0, capUsd),
        spentUsd: 0,
        callCount: 0,
        reservedUsd: 0,
      });
    }
    return { ok: true, mode: "live", providerId: this.id };
  }

  async reserve(
    period: string,
    category: CostCategory,
    estimatedUsd: number,
  ): Promise<CostBudgetStoreReserveResult> {
    const budget = this.budgets.get(costBudgetId(period, category));
    if (!budget) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: `No budget configured for period '${period}' category '${category}'.`,
      };
    }
    if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: "Reservation estimate must be a non-negative finite number.",
      };
    }
    const committed = budget.spentUsd + (budget.reservedUsd ?? 0);
    if (committed + estimatedUsd > budget.capUsd) {
      return {
        ok: false,
        mode: "blocked",
        providerId: this.id,
        error: "Reservation would exceed the configured budget cap.",
      };
    }
    const reservationId = `res-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.reservations.set(reservationId, { period, category, estimatedUsd, settled: false });
    this.budgets.set(costBudgetId(period, category), {
      ...budget,
      reservedUsd: (budget.reservedUsd ?? 0) + estimatedUsd,
    });
    return { ok: true, mode: "live", providerId: this.id, reservationId };
  }

  async settle(
    reservationId: string,
    actualCostUsd: number | null,
  ): Promise<CostBudgetStoreSettleResult> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      return { ok: false, mode: "blocked", providerId: this.id, error: "Unknown reservation." };
    }
    // Idempotent: a second settle for the same reservation is a no-op.
    if (reservation.settled) {
      return { ok: true, mode: "live", providerId: this.id };
    }
    const id = costBudgetId(reservation.period, reservation.category);
    const budget = this.budgets.get(id);
    if (!budget) {
      return { ok: false, mode: "blocked", providerId: this.id, error: "Budget row disappeared." };
    }
    // An unmeasured cost is charged at the reserved estimate (never zero, and
    // never released as though the call were free).
    const charged =
      actualCostUsd === null ? reservation.estimatedUsd : Math.max(0, actualCostUsd);
    this.budgets.set(id, {
      ...budget,
      spentUsd: budget.spentUsd + charged,
      reservedUsd: Math.max(0, (budget.reservedUsd ?? 0) - reservation.estimatedUsd),
      callCount: budget.callCount + 1,
    });
    reservation.settled = true;
    return { ok: true, mode: "live", providerId: this.id };
  }
}

export function createCostBudgetStore(
  env: Record<string, string | undefined> = process.env,
): CostBudgetStore {
  const driver = (env.DF_COST_BUDGET_DRIVER ?? "").trim().toLowerCase();
  if (!driver || driver === "console") return new ConsoleCostBudgetProvider();

  if (driver === "sqlite") {
    const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
    const platform = (env.DF_PLATFORM_PROVIDER ?? "").trim().toLowerCase();
    const stage = (platform === "vercel" ? env.VERCEL_ENV : env.DF_DEPLOYMENT_ENV)
      ?.trim()
      .toLowerCase();
    if (nodeEnv === "production" || stage === "preview" || stage === "production") {
      throw new CostBudgetConfigurationError(
        "SQLite cost budgets are local-only; use PostgreSQL in deployed environments.",
      );
    }
    const path = (env.DF_COST_BUDGET_DB_PATH ?? "").trim();
    if (!path) {
      throw new CostBudgetConfigurationError(
        "DF_COST_BUDGET_DRIVER=sqlite requires DF_COST_BUDGET_DB_PATH.",
      );
    }
    return new SqliteCostBudgetAdapter(path);
  }

  if (driver === "postgres") {
    const connectionString = (
      env.DF_COST_BUDGET_DATABASE_URL ??
      env.DF_RUN_HISTORY_DATABASE_URL ??
      ""
    ).trim();
    if (!connectionString) {
      throw new CostBudgetConfigurationError(
        "DF_COST_BUDGET_DRIVER=postgres requires DF_COST_BUDGET_DATABASE_URL or DF_RUN_HISTORY_DATABASE_URL.",
      );
    }
    if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
      throw new CostBudgetConfigurationError(
        "Cost budget database URL must use postgres:// or postgresql://.",
      );
    }
    return new PostgresCostBudgetAdapter(connectionString);
  }

  throw new CostBudgetConfigurationError(
    `Unknown DF_COST_BUDGET_DRIVER '${driver}'. Supported: console, sqlite, postgres.`,
  );
}