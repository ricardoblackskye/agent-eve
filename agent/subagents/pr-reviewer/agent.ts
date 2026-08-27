import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  name: "openrouter",
});

const modelName = process.env.MODEL_NAME;
if (!modelName) {
  throw new Error("MODEL_NAME environment variable is required");
}

export default defineAgent({
  description:
    "You are a senior software engineer reviewing this code diff. Look for architectural anti-patterns, security risks, and off-by-one errors.",
  model: openrouter.chat(modelName),
  modelContextWindowTokens: 256000,
});
