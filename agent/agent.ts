import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.AI_GATEWAY_API_KEY,
  name: "openrouter",
});

export default defineAgent({
  model: openrouter.chat("nvidia/nemotron-3-ultra-550b-a55b:free"),
  modelContextWindowTokens: 1_048_576,
});
