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
    "Sprint Metrics Analyst: reads the GitHub Kanban board and produces a " +
    "senior-management-ready sprint report (cycle time, throughput, " +
    "work-in-progress). Generates the report and delivers it to the requesting " +
    "issue as a linked file plus an inline summary.",
  model: openrouter.chat(process.env.MODEL_NAME || DEFAULT_MODEL),
  modelContextWindowTokens: 1_048_576,
});
