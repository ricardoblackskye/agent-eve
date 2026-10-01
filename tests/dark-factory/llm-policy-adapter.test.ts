import { describe, expect, it } from "vitest";
import {
  applyThinkingPolicy,
  supportsReasoning,
} from "../../agent/lib/dark-factory/llm-policy-adapter";
import type { LlmPolicy } from "../../agent/lib/dark-factory/llm-policy";

const REASONING_MODEL = "deepseek/deepseek-v4.1-flash";
const PLAIN_MODEL = "deepseek/deepseek-chat";

function policy(over: Partial<LlmPolicy> = {}): LlmPolicy {
  return { thinkingLevel: "medium", maxSteps: 10, ...over };
}

describe("supportsReasoning", () => {
  it("recognises the reasoning models this project actually uses", () => {
    expect(supportsReasoning(REASONING_MODEL)).toBe(true);
    expect(supportsReasoning("deepseek/deepseek-reasoner")).toBe(true);
  });

  it("treats a plain chat model as not reasoning-capable", () => {
    expect(supportsReasoning(PLAIN_MODEL)).toBe(false);
  });

  it("is fail-safe for an unknown model rather than assuming capability", () => {
    expect(supportsReasoning("some/unknown-model")).toBe(false);
    expect(supportsReasoning("")).toBe(false);
  });
});

describe("applyThinkingPolicy", () => {
  it("sends no reasoning parameter when the level is off", () => {
    const applied = applyThinkingPolicy(REASONING_MODEL, policy({ thinkingLevel: "off" }));
    expect(applied.reasoning).toBeUndefined();
    // "off" is a deliberate instruction, so it counts as applied.
    expect(applied.applied).toBe(true);
  });

  it("maps each active level to reasoning.effort", () => {
    for (const level of ["low", "medium", "high"] as const) {
      const applied = applyThinkingPolicy(REASONING_MODEL, policy({ thinkingLevel: level }));
      expect(applied.reasoning).toEqual({ effort: level });
      expect(applied.applied).toBe(true);
      expect(applied.reason).toBeUndefined();
    }
  });

  it("degrades gracefully on a model that cannot reason, and says so", () => {
    const applied = applyThinkingPolicy(PLAIN_MODEL, policy({ thinkingLevel: "high" }));
    expect(applied.reasoning).toBeUndefined();
    expect(applied.applied).toBe(false);
    expect(applied.reason).toMatch(/reasoning/i);
    expect(applied.reason).toContain(PLAIN_MODEL);
  });

  it("never emits both effort and max_tokens, which OpenRouter rejects", () => {
    for (const level of ["off", "low", "medium", "high"] as const) {
      const applied = applyThinkingPolicy(REASONING_MODEL, policy({ thinkingLevel: level }));
      // `reasoning` is absent for "off", so normalise before asserting shape.
      expect(applied.reasoning ?? {}).not.toHaveProperty("max_tokens");
      expect(Object.keys(applied.reasoning ?? {})).not.toContain("max_tokens");
    }
  });

  it("resolves the model from the policy override when present", () => {
    const applied = applyThinkingPolicy(
      PLAIN_MODEL,
      policy({ model: REASONING_MODEL }),
    );
    expect(applied.model).toBe(REASONING_MODEL);
    // Capability follows the RESOLVED model, not the one passed in.
    expect(applied.applied).toBe(true);
    expect(applied.reasoning).toEqual({ effort: "medium" });
  });

  it("falls back to the supplied model when the policy has no override", () => {
    expect(applyThinkingPolicy(PLAIN_MODEL, policy()).model).toBe(PLAIN_MODEL);
  });

  it("stays provider-neutral: no vendor-specific keys in the result", () => {
    const applied = applyThinkingPolicy(REASONING_MODEL, policy({ thinkingLevel: "low" }));
    expect(Object.keys(applied).sort()).toEqual(
      ["applied", "model", "reasoning"].sort(),
    );
    expect(Object.keys(applied.reasoning ?? {})).toEqual(["effort"]);
  });
});