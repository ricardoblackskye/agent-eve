/**
 * L2 quality regression (issue #121 / #122) — live, skippable.
 *
 * Sends a fixed graded prompt to the configured model and asserts the output
 * still meets capability gates (structured story with required sections, no
 * refusal). This is the cheapest meaningful signal that a model swap did not
 * degrade output quality for the agent's core task. Skips when no
 * OPENROUTER_API_KEY or offline.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL_ID } from "../agent/model-config";
import {
  measureLatency,
  gradeStoryQuality,
  loadModelBaseline,
} from "./helpers/model-bench";

function hasKey(): boolean {
  return (
    !!process.env.OPENROUTER_API_KEY &&
    process.env.MODEL_BENCH_OFFLINE !== "1"
  );
}

async function completeOnce(opts: {
  modelId: string;
  apiKey: string;
  prompt: string;
}): Promise<string> {
  // Non-streaming completion for a clean full-text grade.
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.modelId,
      stream: false,
      messages: [{ role: "user", content: opts.prompt }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter returned ${res.status}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}

describe("model quality regression (L2)", () => {
  it(`output of ${DEFAULT_MODEL_ID} still meets story-quality gates`, async () => {
    if (!hasKey()) {
      console.warn(
        "[model-quality] SKIPPED (no OPENROUTER_API_KEY or MODEL_BENCH_OFFLINE=1)",
      );
      expect(true).toBe(true);
      return;
    }
    const { quality, gradedPrompt } = loadModelBaseline();
    const text = await completeOnce({
      modelId: DEFAULT_MODEL_ID,
      apiKey: process.env.OPENROUTER_API_KEY!,
      prompt: gradedPrompt,
    });

    if (process.env.MODEL_BENCH_RECORD === "1") {
      console.log(`[model-quality] RECORD output:\n${text}`);
    }

    const result = gradeStoryQuality(text, quality);
    expect(
      result.passed,
      `quality gate failed: ${JSON.stringify(result.failures)}\n---\n${text}`,
    ).toBe(true);
  });
});
