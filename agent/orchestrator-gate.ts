/**
 * Dark Factory — orchestrator cost gate (#217, epic #206 R7.2).
 *
 * Thin, backward-compatible wrapper over the shared category-parameterised gate
 * (#270): the orchestrator surface is simply `category: "orchestrator"`. The gate
 * is instantiated before `buildDynamicOrchestratorModel` returns a model, and a
 * refusal THROWS — failing the turn before the provider call is made.
 *
 * OPT-IN: returns `null` when cost governance is not configured, so an
 * unconfigured deployment pays nothing and behaves exactly as before.
 */

import type { OrchestratorGate } from "./orchestrator-model";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  createCostGate,
} from "./lib/dark-factory/cost-gate";
import type { CostGovernor } from "./lib/dark-factory/cost-governor";

/** Default upper bound for the orchestrator's completion, used to reserve. */
export const ORCHESTRATOR_MAX_OUTPUT_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;

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
  return createCostGate({ ...input, category: "orchestrator" });
}
