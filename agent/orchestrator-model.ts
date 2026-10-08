/**
 * Dark Factory — orchestrator model resolution (#208 / #217, epic #206 R7.2).
 *
 * The orchestrator's LLM call executes inside the Eve runtime, so shaping it —
 * and gating it before the provider call — means converting `agent/agent.ts`
 * to `defineDynamic`.
 *
 * Contract, read from the installed `eve@0.44.0` types and docs:
 * - `defineDynamic({ events })` supports `session.started`, `turn.started` and
 *   `step.started` (precedence step > turn > session).
 * - A throwing or missing selection FAILS THE TURN BEFORE the provider call —
 *   which is exactly the pre-call gate #217 needs.
 * - With a dynamic model, `modelContextWindowTokens` / `modelOptions` are
 *   forbidden as siblings and must be returned per call.
 * - `reasoning` lives on the shared agent base, so it IS valid alongside a
 *   dynamic model. It is provider-agnostic and maps 1:1 from our policy.
 *
 * OPT-IN: with no policy and no cost gate configured this returns the same
 * static model as before, so an unconfigured deployment is unchanged.
 */

import type { AgentModelDefinition, AgentStaticModelDefinition } from "eve";
import { buildGovernedDynamicModel } from "./lib/dark-factory/governed-model";
import {
  isLlmPolicyConfigured,
  resolveLlmPolicy,
  type ThinkingLevel,
} from "./lib/dark-factory/llm-policy";

/** Context window for the orchestrator's chat model (previous sibling value). */
export const ORCHESTRATOR_CONTEXT_WINDOW_TOKENS = 1_048_576;

/** eve's provider-agnostic reasoning levels. */
export type EveReasoningLevel = "none" | "low" | "medium" | "high";

/**
 * Map a canonical policy level onto eve's provider-agnostic reasoning.
 *
 * `off` becomes `none` — an explicit "do not reason" rather than an omission,
 * so the operator's intent is expressed in the runtime's own vocabulary.
 */
export function toEveReasoning(level: ThinkingLevel): EveReasoningLevel {
  switch (level) {
    case "off":
      return "none";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
  }
}

export interface OrchestratorGate {
  /** Admit a model call. Throws to refuse it before the provider call. */
  admit(): Promise<void>;
}

export interface OrchestratorBuildInput {
  env: Record<string, string | undefined>;
  /** The model to use when the policy sets no override. */
  chatModel: AgentStaticModelDefinition;
  /** Cost gate (#217). Throws to refuse the call before it starts. */
  gate?: OrchestratorGate | null;
}

/** The runtime shape of a `defineDynamic(...)` result. */
export interface DynamicModelSentinel {
  kind: "eve:dynamic";
  events: {
    "step.started": (
      event: unknown,
      ctx: unknown,
    ) => Promise<{ model: unknown; modelContextWindowTokens: number }>;
  };
}

export type OrchestratorModel = AgentModelDefinition;

/**
 * Build the orchestrator's model handle.
 *
 * Returns the static model when nothing is configured. Otherwise returns a
 * dynamic resolver that (a) runs the cost gate first, so a refusal fails the
 * turn before the provider call, and (b) returns the model plus the context
 * window, which a dynamic model cannot declare as a sibling.
 *
 * A malformed policy throws HERE, at startup, rather than mid-turn.
 *
 * The `defineDynamic` result is cast to `AgentModelDefinition`: its inferred
 * sentinel generic does not unify with `PublicAgentDynamicModelResult`, and the
 * runtime shape is verified by tests rather than by the compiler. This is the
 * one place in the release that cannot be exercised without the Eve runtime.
 */
export function buildOrchestratorModel(
  input: OrchestratorBuildInput,
): OrchestratorModel {
  const { env, chatModel, gate } = input;
  const policyConfigured = isLlmPolicyConfigured(env);
  const gateConfigured = gate !== null && gate !== undefined;

  // Fail closed at startup rather than on the first turn.
  if (policyConfigured) resolveLlmPolicy(env);

  if (!policyConfigured && !gateConfigured) {
    return chatModel;
  }

  return buildDynamicOrchestratorModel(
    input,
  ) as unknown as AgentModelDefinition;
}

/**
 * The dynamic resolver itself — delegates to the shared governed model (#270).
 *
 * Deliberately WITHOUT an explicit return type so TypeScript infers the sentinel
 * from `defineDynamic`. `defineAgent` requires an exact match against one of its
 * model branches, so widening this to the union type makes the definition fail to
 * compile — the inference is load-bearing.
 */
export function buildDynamicOrchestratorModel(input: OrchestratorBuildInput) {
  return buildGovernedDynamicModel({
    chatModel: input.chatModel,
    contextWindowTokens: ORCHESTRATOR_CONTEXT_WINDOW_TOKENS,
    gate: input.gate,
  });
}
