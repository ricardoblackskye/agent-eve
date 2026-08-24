import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  name: "openrouter",
});

export default defineAgent({
  model: openrouter.chat("deepseek/deepseek-v4-pro"),
  modelContextWindowTokens: 1_048_576,
});