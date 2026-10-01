/**
 * `maxSteps` governance (#208, epic #206 R7.2).
 *
 * `DF_LLM_MAX_STEPS` governs the loop bounds that actually mean "steps":
 * the developer iteration cap (`DF_MAX_ITERATIONS`) and the review-round cap
 * (`DF_MAX_REVIEW_ROUNDS`).
 *
 * Precedence (decision 6a, layered):
 *   explicit per-surface DF_MAX_*  >  DF_LLM_MAX_STEPS  >  built-in default
 *
 * So an unconfigured deployment is unchanged, and a deployment that already set
 * the older variables keeps its behaviour exactly.
 *
 * The circuit-breaker bounds (`DF_MAX_TRIPS_PER_PBI`,
 * `DF_MAX_WORKER_MINUTES_PER_PBI`, `DF_MAX_FAILED_SELFCORRECT`, ...) are NOT
 * step bounds and are deliberately untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_REVIEW_ROUNDS,
  resolveMaxReviewRounds,
} from "../../agent/lib/dark-factory/definition-of-done";
import { createDeveloperAgent } from "../../agent/lib/dark-factory/developer-agent";
import { EnvConfigError } from "../../agent/lib/dark-factory/llm-policy";
import { InMemoryMetricsStore } from "../../agent/lib/dark-factory/metrics";

const KEYS = [
  "DF_LLM_THINKING_LEVEL",
  "DF_LLM_MAX_STEPS",
  "DF_LLM_MODEL",
  "DF_MAX_ITERATIONS",
  "DF_MAX_REVIEW_ROUNDS",
];

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** The iteration cap the agent actually resolves at construction time. */
function agentIterations(): number {
  return createDeveloperAgent({ metrics: new InMemoryMetricsStore() })
    .maxIterations;
}

describe("maxSteps governance", () => {
  it("keeps the existing defaults when no policy is configured", () => {
    expect(resolveMaxReviewRounds()).toBe(DEFAULT_MAX_REVIEW_ROUNDS);
    expect(agentIterations()).toBe(10);
  });

  it("keeps explicit per-surface overrides working", () => {
    process.env.DF_MAX_REVIEW_ROUNDS = "5";
    process.env.DF_MAX_ITERATIONS = "4";

    expect(resolveMaxReviewRounds()).toBe(5);
    expect(agentIterations()).toBe(4);
  });

  it("governs both step bounds from DF_LLM_MAX_STEPS", () => {
    process.env.DF_LLM_MAX_STEPS = "8";

    expect(resolveMaxReviewRounds()).toBe(8);
    expect(agentIterations()).toBe(8);
  });

  it("lets an explicit per-surface override beat the policy", () => {
    process.env.DF_LLM_MAX_STEPS = "8";
    process.env.DF_MAX_REVIEW_ROUNDS = "5";
    process.env.DF_MAX_ITERATIONS = "4";

    expect(resolveMaxReviewRounds()).toBe(5);
    expect(agentIterations()).toBe(4);
  });

  it("fails closed on a malformed policy even when an override is present", () => {
    process.env.DF_LLM_MAX_STEPS = "many";
    process.env.DF_MAX_ITERATIONS = "4";

    expect(() => resolveMaxReviewRounds()).toThrow(EnvConfigError);
    expect(() => agentIterations()).toThrow(EnvConfigError);
  });

  it("still rejects a malformed explicit override", () => {
    process.env.DF_MAX_REVIEW_ROUNDS = "3.0";
    expect(() => resolveMaxReviewRounds()).toThrow(/DF_MAX_REVIEW_ROUNDS/);

    delete process.env.DF_MAX_REVIEW_ROUNDS;
    process.env.DF_MAX_ITERATIONS = "1e3";
    expect(() => agentIterations()).toThrow(/DF_MAX_ITERATIONS/);
  });

  it("does not govern bounds that are not step bounds", () => {
    process.env.DF_LLM_MAX_STEPS = "8";
    process.env.DF_MAX_TRIPS_PER_PBI = "42";

    // Only the two step bounds move; the circuit-breaker var is left alone.
    expect(resolveMaxReviewRounds()).toBe(8);
    expect(agentIterations()).toBe(8);
    expect(process.env.DF_MAX_TRIPS_PER_PBI).toBe("42");
  });
});
