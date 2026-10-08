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
  createCostGovernor,
  type CostGovernor,
} from "./cost-governor";
import type { CostCategory } from "./cost-budget";

/** Default upper bound for a completion, used for the pre-call reservation. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

export interface CostGate {
  /** Admit a model call. Throws to refuse it before the provider call. */
  admit(): Promise<void>;
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
    async admit(): Promise<void> {
      const decision = await governor.admit({
        category,
        model,
        inputTokens,
        outputTokens,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      });
      if (!decision.admitted) {
        const forTenant = input.tenantId
          ? ` for tenant '${input.tenantId}'`
          : "";
        throw new Error(
          `${category} cost gate refused the call${forTenant}: ${decision.reason ?? "budget_unavailable"}`,
        );
      }
    },
  };
}
