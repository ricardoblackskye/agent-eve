import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  name: "openrouter",
});

export default defineAgent({
  description:
    "Release Manager: generates and maintains release notes from PR events, and creates architecture documentation. Called when a GitHub PR is created, updated, or merged.",
  model: openrouter.chat("nvidia/nemotron-3-ultra-550b-a55b:free"),
  modelContextWindowTokens: 1_048_576,
});
