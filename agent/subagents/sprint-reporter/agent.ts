import { createOpenAI } from "@ai-sdk/openai";
import { defineAgent } from "eve";
import { DEFAULT_MODEL_ID } from "../../model-config";
import { buildGovernedDynamicModel } from "../../lib/dark-factory/governed-model";
import { createCostGate } from "../../lib/dark-factory/cost-gate";

const CONTEXT_WINDOW_TOKENS = 1_048_576;
const MODEL_ID = process.env.MODEL_NAME || DEFAULT_MODEL_ID;

const openrouter = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
  name: "openrouter",
});

const chatModel = openrouter.chat(MODEL_ID);

// Cost gate (#270): OPT-IN — `null` unless a budget backend is configured.
const gate = createCostGate({
  category: "orchestrator",
  env: process.env,
  model: MODEL_ID,
  inputTokens: CONTEXT_WINDOW_TOKENS,
});

const description =
  "Sprint Metrics Analyst: reads the GitHub Kanban board and produces a " +
  "senior-management-ready sprint report (cycle time, throughput, " +
  "work-in-progress). Generates the report and delivers it to the requesting " +
  "issue as a linked file plus an inline summary.";

// Two COMPLETE definitions (see the product-owner note): a dynamic model forbids
// `modelContextWindowTokens` as a sibling, and a spread would widen the union.
const definition =
  gate === null
    ? defineAgent({
        description,
        model: chatModel,
        modelContextWindowTokens: CONTEXT_WINDOW_TOKENS,
      })
    : defineAgent({
        description,
        model: buildGovernedDynamicModel({
          chatModel,
          contextWindowTokens: CONTEXT_WINDOW_TOKENS,
          gate,
        }),
      });

export default definition;
