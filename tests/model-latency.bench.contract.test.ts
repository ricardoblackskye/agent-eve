/**
 * L1 latency benchmark (issue #121 / #122) — live, skippable.
 *
 * Calls OpenRouter chat completions for the configured model with a fixed
 * prompt and asserts latency stays within the committed budget
 * (tests/helpers/../fixtures/model-baseline.json). Skips when no
 * OPENROUTER_API_KEY or offline so CI never flakes.
 *
 * Re-baseline live: run WITH a key and MODEL_BENCH_RECORD=1, then commit the
 * printed measured values into the fixture's latency.baselineMs.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_MODEL_ID } from "../agent/model-config";
import {
  measureLatency,
  assertLatencyWithinBudget,
  loadModelBaseline,
} from "./helpers/model-bench";

function hasKey(): boolean {
  return (
    !!process.env.OPENROUTER_API_KEY &&
    process.env.MODEL_BENCH_OFFLINE !== "1"
  );
}

describe("model latency benchmark (L1)", () => {
  it(`latency of ${DEFAULT_MODEL_ID} stays within budget`, async () => {
    if (!hasKey()) {
      console.warn(
        "[model-latency] SKIPPED (no OPENROUTER_API_KEY or MODEL_BENCH_OFFLINE=1)",
      );
      expect(true).toBe(true);
      return;
    }
    const { latency, gradedPrompt } = loadModelBaseline();
    const measured = await measureLatency({
      modelId: DEFAULT_MODEL_ID,
      apiKey: process.env.OPENROUTER_API_KEY!,
      prompt: gradedPrompt,
    });

    if (process.env.MODEL_BENCH_RECORD === "1") {
      console.log(
        `[model-latency] RECORD ttftMs=${measured.ttftMs} totalMs=${measured.totalMs}`,
      );
    }

    const violations = assertLatencyWithinBudget(measured, latency);
    expect(
      violations,
      `latency budget violated: ${JSON.stringify(violations)} (measured ttft=${measured.ttftMs}ms total=${measured.totalMs}ms)`,
    ).toEqual([]);
  });
});
