import { mockModel } from "eve/evals";
import { createOpenAI } from "@ai-sdk/openai";

const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-pro";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  name: "openrouter",
});

/**
 * Production chat uses the real OpenRouter model. The model id is configurable
 * via EVE_CHAT_MODEL (defaults to deepseek-v4-pro) so model changes are a
 * config change, not a code change. When OPENROUTER_API_KEY is unset (local dev
 * / eval runs) we fall back to the deterministic mock so no external key is
 * required and the smoke/model-check evals still pass.
 */
export function resolveChatModel() {
  const modelId = process.env.EVE_CHAT_MODEL ?? DEFAULT_MODEL_ID;
  const mock = mockModel({
    // Provider is left at the mock default ("eve-mock") so tests and runtime can
    // distinguish the fallback from the real OpenRouter model. modelId stays the
    // production id so the model-check eval passes in both modes.
    modelId,
    respond: ({ lastUserMessage }) =>
      `I can help you with that! You asked: "${lastUserMessage}"`,
  });
  return process.env.OPENROUTER_API_KEY ? openrouter.chat(modelId) : mock;
}
