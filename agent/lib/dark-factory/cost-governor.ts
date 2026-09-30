/**
 * Dark Factory — LLM cost governor.
 *
 * Sits between an LLM call site and the budget store. It estimates the call's
 * maximum cost from the model price table, reserves it against the category's
 * cap, and reconciles the actual cost afterwards. Every refusal is a structured
 * result (never a thrown crash) so a call site can short-circuit cleanly.
 *
 * FAIL-CLOSED: an unconfigured cap, an unknown model price, or an unavailable
 * store all refuse the call rather than letting it run unbounded.
 */

import {
  type CostBudget,
  type CostCategory,
  createCostGovernanceEnv,
  estimateCost,
  resolvePrice,
} from "./cost-budget";
import {
  type CostBudgetStore,
  costBudgetId,
} from "./cost-budget-store";

/** Why a call was refused. Machine-readable for run status/UI. */
export type CostGovernorRefusal =
  | "not_configured"
  | "unpriced_model"
  | "budget_exceeded"
  | "budget_unavailable";

export interface CostGovernorDecision {
  admitted: boolean;
  /** Present only when admitted. */
  reservationId?: string;
  estimatedUsd?: number;
  period?: string;
  reason?: CostGovernorRefusal;
  error?: string;
}

export interface CostGovernorAdmitInput {
  category: CostCategory;
  /** Provider model id; `null`/unknown is refused, never estimated at zero. */
  model: string | null | undefined;
  inputTokens: number;
  outputTokens: number;
}

export interface CostGovernorSettleResult {
  ok: boolean;
  error?: string;
}

export interface CostGovernor {
  readonly id: string;
  /** The active billing period key for a given instant (UTC `YYYY-MM`). */
  period(now?: Date): string;
  admit(input: CostGovernorAdmitInput): Promise<CostGovernorDecision>;
  settle(reservationId: string, actualCostUsd: number | null): Promise<CostGovernorSettleResult>;
  /** Read-only budget rows, for the operator dashboard. */
  status(period?: string): Promise<CostBudget[]>;
}

/** `YYYY-MM` in UTC. */
export function utcMonth(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

const CONCRETE_PERIOD = /^\d{4}-\d{2}$/;

export function createCostGovernor(
  store: CostBudgetStore,
  env: Record<string, string | undefined> = process.env,
): CostGovernor {
  const resolved = createCostGovernanceEnv(env);
  const configuredPeriod = resolved.period;

  const resolvePeriod = (now: Date = new Date()): string =>
    CONCRETE_PERIOD.test(configuredPeriod) ? configuredPeriod : utcMonth(now);

  return {
    id: `governor:${store.id}`,

    period: resolvePeriod,

    async admit(input: CostGovernorAdmitInput): Promise<CostGovernorDecision> {
      const period = resolvePeriod();
      const cap = resolved.categories[input.category];
      if (typeof cap !== "number" || !Number.isFinite(cap)) {
        return {
          admitted: false,
          reason: "not_configured",
          period,
          error: `No cost cap configured for category '${input.category}'.`,
        };
      }
      if (!resolvePrice(input.model)) {
        return {
          admitted: false,
          reason: "unpriced_model",
          period,
          error: `No price is known for model '${String(input.model)}'; refusing an unbounded call.`,
        };
      }
      const estimatedUsd = estimateCost(input.model, input.inputTokens, input.outputTokens);

      const ensured = await store.ensureBudget(period, input.category, cap);
      if (!ensured.ok) {
        return {
          admitted: false,
          reason: "budget_unavailable",
          period,
          error: ensured.error ?? "Cost budget store is unavailable.",
        };
      }

      const reserved = await store.reserve(period, input.category, estimatedUsd);
      if (!reserved.ok || !reserved.reservationId) {
        const exceeded = /exceed/i.test(reserved.error ?? "");
        return {
          admitted: false,
          reason: exceeded ? "budget_exceeded" : "budget_unavailable",
          period,
          error: reserved.error ?? "Cost budget reservation was refused.",
        };
      }

      return { admitted: true, reservationId: reserved.reservationId, estimatedUsd, period };
    },

    async settle(
      reservationId: string,
      actualCostUsd: number | null,
    ): Promise<CostGovernorSettleResult> {
      const settled = await store.settle(reservationId, actualCostUsd);
      return settled.ok ? { ok: true } : { ok: false, error: settled.error };
    },

    async status(period?: string): Promise<CostBudget[]> {
      const read = await store.listBudgets(period ?? resolvePeriod());
      return read.ok ? read.value : [];
    },
  };
}

/** Budget row key helper, re-exported for callers that store reservation ids. */
export { costBudgetId };