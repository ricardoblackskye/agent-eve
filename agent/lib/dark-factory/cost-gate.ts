/**
 * Dark Factory — category-parameterized cost gate (#270, generalizing #217).
 *
 * The pre-call gate that a dynamic model resolver runs before returning a model.
 * A refusal THROWS, which fails the turn before the provider call is made.
 *
 * OPT-IN: returns `null` when cost governance is not configured, so an unconfigured
 * deployment pays nothing and behaves exactly as before.
 */

import {
  createCostBudgetStore,
  isCostGovernanceConfigured,
} from "./cost-budget-store";
import {
  CostRefusedError,
  createCostGovernor,
  type CostGovernor,
} from "./cost-governor";
import { estimateCost, type CostCategory } from "./cost-budget";

/** Default upper bound for a completion, used for the pre-call reservation. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

/**
 * A reservation an admission took, with the means to reconcile it (#443).
 *
 * Without this the reservationId returned by the governor had nowhere to go: the
 * gate admitted, the model call ran, and the reserved budget was never released
 * or converted to spend.
 */
export interface CostAdmission {
  /**
   * Reconcile the reservation.
   *
   * - the measured cost, when the provider reported one
   * - `null` when the call ran but usage was unavailable - the reserved estimate
   *   is charged, matching the store's long-standing rule
   * - `0` when the call never reached the provider, so nothing was consumed
   */
  settle(actualCostUsd: number | null): Promise<void>;
  /**
   * Settle from provider-reported usage, priced with the model this gate reserved
   * against. An unknown price falls back to `null` (the estimate is charged),
   * because settling 0 would release budget for a call that DID run.
   */
  settleFromUsage(usage: { inputTokens?: number; outputTokens?: number } | null | undefined): Promise<void>;
}

export interface CostGate {
  /** Admit a model call. Throws to refuse it before the provider call. */
  admit(): Promise<CostAdmission | void>;
}

export interface CostGateInput {
  /** The canonical cost surface this gate protects. */
  category: CostCategory;
  env: Record<string, string | undefined>;
  /** Model id used for price lookup; an unpriced model is refused, not guessed. */
  model: string;
  /** Upper-bound input tokens for the pre-call reservation. */
  inputTokens: number;
  /** Upper-bound output tokens. */
  outputTokens?: number;
  /**
   * The attributed customer tenant (#230). Absent governs the GLOBAL budget;
   * present governs that tenant's operator-provisioned budget.
   */
  tenantId?: string;
  /**
   * Injectable governor, for tests. Omit to build one from the environment;
   * pass `null` explicitly to disable gating regardless of configuration.
   */
  governor?: CostGovernor | null;
}

export function createCostGate(input: CostGateInput): CostGate | null {
  const { env, model, inputTokens, category } = input;
  const outputTokens = input.outputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  const governor =
    input.governor !== undefined
      ? input.governor
      : isCostGovernanceConfigured(env)
        ? createCostGovernor(createCostBudgetStore(env), env)
        : null;

  if (!governor) return null;

  return {
    async admit(): Promise<CostAdmission> {
      const decision = await governor.admit({
        category,
        model,
        inputTokens,
        outputTokens,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      });
      if (!decision.admitted) {
        // #458: a typed refusal, so the reason is a FIELD a caller can branch on rather
        // than a word inside a string, and the store's own message survives with it.
        throw new CostRefusedError({
          reason: decision.reason ?? "budget_unavailable",
          category,
          ...(decision.period ? { period: decision.period } : {}),
          ...(input.tenantId ? { tenantId: input.tenantId } : {}),
          ...(decision.error ? { storeError: decision.error } : {}),
        });
      }

      // #443: hand the reservation back to the caller. It used to be discarded here,
      // so the reserved budget could never be settled - the gate admitted, the call
      // ran, and `reserved_usd` grew forever.
      const reservationId = decision.reservationId;
      return {
        async settle(actualCostUsd: number | null): Promise<void> {
          if (reservationId) await governor.settle(reservationId, actualCostUsd);
        },
        async settleFromUsage(usage): Promise<void> {
          if (!reservationId) return;
          const priced = estimateCost(
            model,
            usage?.inputTokens ?? 0,
            usage?.outputTokens ?? 0,
          );
          // estimateCost returns 0 for an unpriced model. Settling 0 would RELEASE budget for a
          // call that ran, so settle null and let the reserved estimate be charged instead.
          await governor.settle(reservationId, priced > 0 ? priced : null);
        },
      };
    },
  };
}
