/**
 * Dark Factory — orchestrator cost gate (#217, epic #206 R7.2).
 *
 * Instantiates the pre-call gate that `buildDynamicOrchestratorModel` runs
 * before returning a model. A refusal THROWS, which fails the turn before the
 * provider call is made — the mechanism #217 was blocked on.
 *
 * OPT-IN: returns `null` when cost governance is not configured, so an
 * unconfigured deployment pays nothing and behaves exactly as before.
 */

import {
  createCostBudgetStore,
  isCostGovernanceConfigured,
} from "./lib/dark-factory/cost-budget-store";
import {
  createCostGovernor,
  type CostGovernor,
} from "./lib/dark-factory/cost-governor";
import type { OrchestratorGate } from "./orchestrator-model";

/** Default upper bound for the orchestrator's completion, used to reserve. */
export const ORCHESTRATOR_MAX_OUTPUT_TOKENS = 8_000;

export interface OrchestratorGateInput {
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

/**
 * Build the orchestrator's cost gate, or `null` when it is not configured.
 *
 * A refusal is surfaced as a THROW so it fails the turn before the provider
 * call. An unavailable store is a refusal too — never a free pass.
 */
export function createOrchestratorGate(
  input: OrchestratorGateInput,
): OrchestratorGate | null {
  const { env, model, inputTokens } = input;
  const outputTokens = input.outputTokens ?? ORCHESTRATOR_MAX_OUTPUT_TOKENS;

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
        category: "orchestrator",
        model,
        inputTokens,
        outputTokens,
        ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      });
      if (!decision.admitted) {
        const forTenant = input.tenantId ? ` for tenant '${input.tenantId}'` : "";
        throw new Error(
          `orchestrator cost gate refused the call${forTenant}: ${decision.reason ?? "budget_unavailable"}`,
        );
      }
    },
  };
}
