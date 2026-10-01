/**
 * Dark Factory — orchestrator agent definition.
 *
 * The LLM call policy (#208) and the cost gate (#217) are both OPT-IN. With
 * neither configured this behaves EXACTLY as before: a static model plus a
 * static context window, no `reasoning` sibling and no dynamic resolver.
 *
 * When either IS configured the model becomes a `defineDynamic` resolver, so
 * `modelContextWindowTokens` must move into the resolver's selection — eve
 * forbids it as a sibling of a dynamic model — and the thinking level is
 * expressed through eve's provider-agnostic `reasoning` field.
 */

import { defineAgent } from "eve";
import { resolveChatModel } from "./chat-model";
import {
  CHAT_MODEL_ENV,
  DEFAULT_MODEL_ID,
  FALLBACK_MODEL_ID,
  resolveModelId,
} from "./model-config";
import {
  buildDynamicOrchestratorModel,
  ORCHESTRATOR_CONTEXT_WINDOW_TOKENS,
  toEveReasoning,
} from "./orchestrator-model";
import { createOrchestratorGate } from "./orchestrator-gate";
import {
  isLlmPolicyConfigured,
  resolveLlmPolicy,
} from "./lib/dark-factory/llm-policy";

const policy = isLlmPolicyConfigured(process.env)
  ? resolveLlmPolicy(process.env)
  : null;

const modelId = resolveModelId({
  primary: DEFAULT_MODEL_ID,
  fallback: FALLBACK_MODEL_ID,
  envOverride: policy?.model ?? process.env[CHAT_MODEL_ENV],
});

const chatModel = resolveChatModel(
  policy?.model !== undefined ? { modelId: policy.model } : undefined,
);

// The cost gate reserves against the orchestrator category before each call.
// `null` unless a budget backend is configured, so nothing is gated by default.
const gate = createOrchestratorGate({
  env: process.env,
  model: modelId,
  inputTokens: ORCHESTRATOR_CONTEXT_WINDOW_TOKENS,
});

/**
 * Two COMPLETE definitions rather than one with conditional spreads.
 *
 * `defineAgent` requires an exact match against one of its model branches: a
 * spread-built object widens `model` to the union of both, which then matches
 * neither. Only the selected branch is evaluated, so the unconfigured path
 * stays byte-identical to the previous definition.
 */
const definition =
  policy === null && gate === null
    ? defineAgent({
        model: chatModel,
        modelContextWindowTokens: ORCHESTRATOR_CONTEXT_WINDOW_TOKENS,
      })
    : defineAgent({
        model: buildDynamicOrchestratorModel({
          env: process.env,
          chatModel,
          gate,
        }),
        ...(policy !== null
          ? { reasoning: toEveReasoning(policy.thinkingLevel) }
          : {}),
      });

export default definition;
