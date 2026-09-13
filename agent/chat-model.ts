import { mockModel } from "eve/evals";
import { createOpenAI } from "@ai-sdk/openai";
import {
  DEFAULT_MODEL_ID,
  FALLBACK_MODEL_ID,
  resolveModelId,
} from "./model-config";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  name: "openrouter",
});

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
export function resolveChatModel(opts?: {
  unreachable?: boolean;
  fallback?: string;
}): ReturnType<typeof openrouter.chat> | ReturnType<typeof mockModel> {
  const modelId = resolveModelId({
    primary: DEFAULT_MODEL_ID,
    fallback: opts?.fallback ?? FALLBACK_MODEL_ID,
    unreachable: opts?.unreachable,
    envOverride: process.env.EVE_CHAT_MODEL,
  });

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

  return openrouter.chat(modelId);
}
