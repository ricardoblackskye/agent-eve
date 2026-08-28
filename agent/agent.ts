import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// Use the real OpenRouter model when the API key is available.
// Fall back to a deterministic mock model for local evals without a key.
const openrouterKey = process.env.OPENROUTER_API_KEY;

const model = openrouterKey
  ? createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: openrouterKey,
      name: "openrouter",
    }).chat("nvidia/nemotron-3-ultra-550b-a55b:free")
  : mockModel({
      modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
      provider: "openrouter",
      respond: ({ lastUserMessage }) =>
        `I can help you with that! You asked: "${lastUserMessage}"`,
    });

export default defineAgent({
  model,
  modelContextWindowTokens: 1_048_576,
});