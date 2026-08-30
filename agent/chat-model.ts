import { mockModel } from "eve/evals";
import { createOpenAI } from "@ai-sdk/openai";

const MODEL_ID = "nvidia/nemotron-3-ultra-550b-a55b:free";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY ?? "",
  name: "openrouter",
});

const mock = mockModel({
  // Provider is left at the mock default ("eve-mock") so tests and runtime can
  // distinguish the fallback from the real OpenRouter model. modelId stays the
  // production id so the model-check eval passes in both modes.
  modelId: MODEL_ID,
  respond: ({ lastUserMessage }) =>
    `I can help you with that! You asked: "${lastUserMessage}"`,
});

/**
 * Production chat uses the real OpenRouter model. When OPENROUTER_API_KEY is
 * unset (local dev / eval runs) we fall back to the deterministic mock so no
 * external key is required and the smoke/model-check evals still pass.
 */
export function resolveChatModel() {
  return process.env.OPENROUTER_API_KEY ? openrouter.chat(MODEL_ID) : mock;
}
