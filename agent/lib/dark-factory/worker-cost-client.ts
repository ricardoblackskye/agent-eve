/**
 * Dark Factory — worker-side cost client (#218, epic #212 R2).
 *
 * The seam a Dark Factory WORKER uses to take a tenant cost reservation before a
 * long-running LLM task and reconcile it to the actual cost afterwards. It is a
 * thin, opt-in client over the governance + budget store already built for the
 * orchestrator (see `cost-governor` / `governed-llm-call`): the worker reserves,
 * does the work, then settles. Real wiring into the worker runtime is R3 (#215).
 *
 * The reservation carries the tenant, so settle lands on the tenant's own budget
 * row. A tenant with no provisioned budget is refused (never auto-provisioned).
 */

import type { CostBudgetStore } from "./cost-budget-store";
import type { CostGovernor, CostGovernorRefusal } from "./cost-governor";

export interface WorkerReserveInput {
  tenantId: string;
  category: import("./cost-budget").CostCategory;
  /** Provider model id; unpriced is refused. */
  model: string | null | undefined;
  inputTokens: number;
  outputTokens: number;
}

export type WorkerReserveResult =
  | { ok: true; reservationId: string }
  | {
      ok: false;
      reason: CostGovernorRefusal;
      tenantId: string;
      error?: string;
    };

export interface WorkerCostClient {
  reserve(input: WorkerReserveInput): Promise<WorkerReserveResult>;
  /** Settle a reservation. `actualUsd` omitted => leave the conservative estimate. */
  settle(reservationId: string, actualUsd?: number): Promise<void>;
}

export function createWorkerCostClient(
  governor: CostGovernor,
  store: CostBudgetStore,
): WorkerCostClient {
  return {
    async reserve(input: WorkerReserveInput): Promise<WorkerReserveResult> {
      const decision = await governor.admit({
        category: input.category,
        model: input.model,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        tenantId: input.tenantId,
      });
      if (!decision.admitted || !decision.reservationId) {
        return {
          ok: false,
          reason: decision.reason ?? "budget_unavailable",
          tenantId: input.tenantId,
          ...(decision.error ? { error: decision.error } : {}),
        };
      }
      return { ok: true, reservationId: decision.reservationId };
    },
    async settle(reservationId: string, actualUsd?: number): Promise<void> {
      // No actual cost reported => leave the conservative reservation in place.
      if (actualUsd === undefined) return;
      const outcome = await store.settle(reservationId, actualUsd);
      if (!outcome.ok) {
        throw new Error(outcome.error ?? "Cost budget settlement failed");
      }
    },
  };
}