/**
 * Dark Factory — governed dynamic model (#270).
 *
 * The category-parameterized `defineDynamic` resolver shared by every agent
 * surface. It runs a cost gate FIRST, so a refusal fails the turn BEFORE the
 * provider call — the mechanism #217 established for the orchestrator, now
 * reused by the subagents.
 *
 * OPT-IN: with no gate it returns the static model unchanged, so an unconfigured
 * deployment is byte-identical to before.
 */

import { defineDynamic } from "eve";
import type { AgentStaticModelDefinition } from "eve";

export interface GovernedGate {
  /** Admit a model call. Throws to refuse it before the provider call. */
  admit(): Promise<void>;
}

export interface GovernedModelInput {
  /** The model to use when no resolver is needed. */
  chatModel: AgentStaticModelDefinition;
  /** Context window reported per call (a dynamic model cannot declare it as a sibling). */
  contextWindowTokens: number;
  /** Cost gate. Throws to refuse the call before it starts. */
  gate?: GovernedGate | null;
}

/**
 * The dynamic resolver used by a CONFIGURED (gated) agent definition.
 *
 * Deliberately WITHOUT an explicit return type so TypeScript infers the sentinel
 * from `defineDynamic`; `defineAgent` requires an exact match against one of its
 * model branches, so widening it makes the definition fail to compile.
 */
export function buildGovernedDynamicModel(input: GovernedModelInput) {
  const { chatModel, contextWindowTokens, gate } = input;

  return defineDynamic({
    events: {
      "step.started": async () => {
        // The gate runs FIRST: a throw here fails the turn before any provider
        // call is made (#217 / #270).
        if (gate != null) await gate.admit();
        return {
          model: chatModel,
          modelContextWindowTokens: contextWindowTokens,
        };
      },
    },
  });
}
