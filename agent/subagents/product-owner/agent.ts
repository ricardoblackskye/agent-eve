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
  "Product Owner: turns a raw feature request or piece of customer feedback into a " +
  "structured, AI-ready user story with machine-verifiable acceptance criteria, " +
  "concrete examples, explicit constraints and NFRs. Pauses to ask a targeted " +
  "clarifying question when the request is too vague to finalize.";

// Two COMPLETE definitions: `defineAgent` requires an exact match against one of
// its model branches, and a dynamic model forbids `modelContextWindowTokens` as a
// sibling. A spread-built object would widen the union and match neither.
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
