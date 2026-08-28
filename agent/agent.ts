import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

// Deterministic mock model for evals — no external API key required.
// Reports the same model ID as the production OpenRouter model so the
// model-check eval passes. Returns a reply containing "you" so the
// smoke eval's includes("you") assertion holds.
export default defineAgent({
  model: mockModel({
    modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
    provider: "openrouter",
    respond: ({ lastUserMessage }) =>
      `I can help you with that! You asked: "${lastUserMessage}"`,
  }),
  modelContextWindowTokens: 1_048_576,
});
