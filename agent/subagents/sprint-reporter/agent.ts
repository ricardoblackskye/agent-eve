import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { DEFAULT_MODEL_ID } from "../../model-config";

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  name: "openrouter",
});

export default defineAgent({
  description:
    "Sprint Metrics Analyst: reads the GitHub Kanban board and produces a " +
    "senior-management-ready sprint report (cycle time, throughput, " +
    "work-in-progress). Generates the report and delivers it to the requesting " +
    "issue as a linked file plus an inline summary.",
  model: openrouter.chat(process.env.MODEL_NAME || DEFAULT_MODEL_ID),
  modelContextWindowTokens: 1_048_576,
});
