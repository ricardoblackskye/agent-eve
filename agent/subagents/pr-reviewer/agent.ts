import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

export default defineAgent({
  description: "You are a helpful assistant.",
  model: openrouter.chat("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"),
  modelContextWindowTokens: 1_048_576,
});
