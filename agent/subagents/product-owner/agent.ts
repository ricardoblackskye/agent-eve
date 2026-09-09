import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  name: "openrouter",
});

const DEFAULT_MODEL = "deepseek/deepseek-v4-pro";

export default defineAgent({
  description:
    "Product Owner: turns a raw feature request or piece of customer feedback into a " +
    "structured, AI-ready user story with machine-verifiable acceptance criteria, " +
    "concrete examples, explicit constraints and NFRs. Pauses to ask a targeted " +
    "clarifying question when the request is too vague to finalize.",
  model: openrouter.chat(process.env.MODEL_NAME || DEFAULT_MODEL),
  modelContextWindowTokens: 1_048_576,
});
