import { mockModel } from "eve/evals";
import { createOpenAI } from "@ai-sdk/openai";
import {
  DEFAULT_MODEL_ID,
  FALLBACK_MODEL_ID,
  resolveModelId,
} from "./model-config";

/**
 * Built on FIRST USE, not at import (#373). The OpenRouter key comes from `.env`, which the runner
 * loads in `initEnv()` - at module scope, but after its own imports have been evaluated, because ESM
 * hoists them. Building this at module scope captured an EMPTY key, so every request went out
 * unauthenticated while the runner's log truthfully reported the key as present.
 */
let openrouterClient: ReturnType<typeof createOpenAI> | undefined;

function openrouter(): ReturnType<typeof createOpenAI> {
  openrouterClient ??= createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY ?? "",
    name: "openrouter",
  });
  return openrouterClient;
}

/**
 * Production chat uses the real OpenRouter model. The model id is configurable
 * via EVE_CHAT_MODEL (defaults to deepseek-v4.1-flash) so model changes are a
 * config change, not a code change. When OPENROUTER_API_KEY is unset (local dev
 * / eval runs) we fall back to the deterministic mock so no external key is
 * required and the smoke/model-check evals still pass.
 *
 * Fallback policy: if the primary model is unreachable and a fallback is
 * configured, the resolver returns the fallback id (never the previous model
 * unless that fallback is explicitly the previous id). The mock fallback (no
 * API key) is unchanged.
 */
type ChatModel =
  | ReturnType<ReturnType<typeof openrouter>["chat"]>
  | ReturnType<typeof mockModel>;

/** The model plus the id that must be reported for it. */
export interface ResolvedChatModel {
  /** Governance prices THIS id, so it must be the id of `model`. */
  modelId: string;
  /** Built from `modelId`, never from a second resolution. */
  model: ChatModel;
}

/** The one place the chat model id is decided. */
function resolveChatModelId(opts?: {
  unreachable?: boolean;
  fallback?: string;
  modelId?: string;
}): string {
  return resolveModelId({
    primary: DEFAULT_MODEL_ID,
    fallback: opts?.fallback ?? FALLBACK_MODEL_ID,
    unreachable: opts?.unreachable,
    envOverride: opts?.modelId ?? process.env.EVE_CHAT_MODEL,
  });
}

/** Build a chat model from an id that has already been resolved. */
function buildChatModel(modelId: string): ChatModel {
  if (!process.env.OPENROUTER_API_KEY) {
    return mockModel({
      // Provider is left at the mock default ("eve-mock") so tests and runtime can
      // distinguish the fallback from the real OpenRouter model. modelId stays the
      // production id so the model-check eval passes in both modes.
      modelId,
      respond: ({ lastUserMessage }) =>
        `I can help you with that! You asked: "${lastUserMessage}"`,
    });
  }

  return openrouter().chat(modelId);
}

export function resolveChatModel(opts?: {
  unreachable?: boolean;
  fallback?: string;
  /** Explicit model id; beats EVE_CHAT_MODEL. Used by the LLM policy (#208). */
  modelId?: string;
}): ChatModel {
  return buildChatModel(resolveChatModelId(opts));
}

/**
 * Resolve the model and the id together, so the id reported to a caller (and
 * therefore to cost governance) cannot differ from the model that is called.
 */
export function resolveChatModelWithId(opts?: {
  unreachable?: boolean;
  fallback?: string;
  modelId?: string;
}): ResolvedChatModel {
  const modelId = resolveChatModelId(opts);
  return { modelId, model: buildChatModel(modelId) };
}
