/**
 * Dark Factory — orchestrator agent definition.
 *
 * The LLM call policy (#208) is OPT-IN. With no `DF_LLM_*` variable set this
 * behaves EXACTLY as before: a static model plus a static context window, with
 * no `reasoning` sibling and no dynamic resolver.
 *
 * When a policy IS configured the model becomes a `defineDynamic` resolver
 * (which also carries the cost gate for #217), so `modelContextWindowTokens`
 * must move into the resolver's selection — eve forbids it as a sibling of a
 * dynamic model — and the thinking level is expressed through eve's
 * provider-agnostic `reasoning` field.
 */

import { defineAgent } from "eve";
import { resolveChatModel } from "./chat-model";
import {
  buildDynamicOrchestratorModel,
  ORCHESTRATOR_CONTEXT_WINDOW_TOKENS,
  toEveReasoning,
} from "./orchestrator-model";
import {
  isLlmPolicyConfigured,
  resolveLlmPolicy,
} from "./lib/dark-factory/llm-policy";

const policy = isLlmPolicyConfigured(process.env)
  ? resolveLlmPolicy(process.env)
  : null;

const chatModel = resolveChatModel(
  policy?.model !== undefined ? { modelId: policy.model } : undefined,
);

/**
 * Two COMPLETE definitions rather than one with conditional spreads.
 *
 * `defineAgent` requires an exact match against one of its model branches: a
 * spread-built object widens `model` to the union of both, which then matches
 * neither. Only the selected branch is evaluated, so the unconfigured path
 * stays byte-identical to the previous definition.
 */
const definition =
  policy === null
    ? defineAgent({
        model: chatModel,
        modelContextWindowTokens: ORCHESTRATOR_CONTEXT_WINDOW_TOKENS,
      })
    : defineAgent({
        model: buildDynamicOrchestratorModel({ env: process.env, chatModel }),
        reasoning: toEveReasoning(policy.thinkingLevel),
      });

export default definition;
