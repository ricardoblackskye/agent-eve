/**
 * Dark Factory — governed LLM call seam.
 *
 * The single wrapper every LLM call site uses to be budget-governed: reserve
 * the call's maximum cost, run it, then reconcile the actual cost. A refusal is
 * returned (not thrown) so a call site can short-circuit; a thrown call still
 * settles conservatively so a reservation is never leaked.
 */

import type { CostCategory } from "./cost-budget";
import type { CostGovernor, CostGovernorRefusal } from "./cost-governor";

export interface GovernedLlmCallOptions<T> {
  governor: CostGovernor;
  category: CostCategory;
  /** Provider model id; must be priced or the call is refused. */
  model: string;
  /** Upper-bound token estimate used for the pre-call reservation. */
  inputTokens: number;
  outputTokens: number;
  /**
   * The attributed customer tenant (#230). Absent governs the GLOBAL budget.
   */
  tenantId?: string;
  /** The real call. Invoked ONLY after the governor admits it. */
  run: () => Promise<T>;
  /** Measured cost from the result; `undefined` = unmeasured. */
  costOf?: (result: T) => number | undefined;
}

export type GovernedLlmCallResult<T> =
  | { ok: true; result: T; reservationId: string; estimatedUsd: number }
  | { ok: false; reason: CostGovernorRefusal; error?: string };

export async function runGovernedLlmCall<T>(
  options: GovernedLlmCallOptions<T>,
): Promise<GovernedLlmCallResult<T>> {
  const decision = await options.governor.admit({
    category: options.category,
    model: options.model,
    inputTokens: options.inputTokens,
    outputTokens: options.outputTokens,
    ...(options.tenantId ? { tenantId: options.tenantId } : {}),
  });

  if (!decision.admitted || !decision.reservationId) {
    return {
      ok: false,
      reason: decision.reason ?? "budget_unavailable",
      error: decision.error,
    };
  }

  const reservationId = decision.reservationId;
  try {
    const result = await options.run();
    const measured = options.costOf?.(result);
    await options.governor.settle(reservationId, measured ?? null);
    return {
      ok: true,
      result,
      reservationId,
      estimatedUsd: decision.estimatedUsd ?? 0,
    };
  } catch (error) {
    // The call failed after the reservation: settle at the estimate so the
    // reserved budget is accounted for, then rethrow the original failure.
    await options.governor.settle(reservationId, null);
    throw error;
  }
}