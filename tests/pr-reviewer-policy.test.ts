import { describe, expect, it } from "vitest";
import { resolveReviewRequestPolicy } from "../scripts/pr-reviewer-policy";
import { EnvConfigError } from "../agent/lib/dark-factory/llm-policy";

const FALLBACK = "deepseek/deepseek-chat";
const REASONING_MODEL = "deepseek/deepseek-v4.1-flash";

describe("resolveReviewRequestPolicy", () => {
  it("stays legacy when no policy is configured, leaving PR_REVIEW_* in charge", () => {
    const resolved = resolveReviewRequestPolicy({}, FALLBACK);
    expect(resolved.legacy).toBe(true);
    expect(resolved.model).toBe(FALLBACK);
    expect(resolved.reasoning).toBeUndefined();
  });

  it("applies a thinking level once the policy is configured", () => {
    const resolved = resolveReviewRequestPolicy(
      { DF_LLM_THINKING_LEVEL: "high", DF_LLM_MODEL: REASONING_MODEL },
      FALLBACK,
    );
    expect(resolved.legacy).toBe(false);
    expect(resolved.model).toBe(REASONING_MODEL);
    expect(resolved.reasoning).toEqual({ effort: "high" });
    expect(resolved.applied).toBe(true);
  });

  it("sends no reasoning parameter when the policy says off", () => {
    const resolved = resolveReviewRequestPolicy(
      { DF_LLM_THINKING_LEVEL: "off" },
      REASONING_MODEL,
    );
    expect(resolved.reasoning).toBeUndefined();
    expect(resolved.applied).toBe(true);
    expect(resolved.legacy).toBe(false);
  });

  it("degrades gracefully on a model that cannot reason, and says why", () => {
    const resolved = resolveReviewRequestPolicy(
      { DF_LLM_THINKING_LEVEL: "high" },
      FALLBACK,
    );
    expect(resolved.reasoning).toBeUndefined();
    expect(resolved.applied).toBe(false);
    expect(resolved.reason).toMatch(/reasoning/i);
    expect(resolved.model).toBe(FALLBACK);
  });

  it("lets the policy model override the reviewer default", () => {
    const resolved = resolveReviewRequestPolicy(
      { DF_LLM_MAX_STEPS: "5", DF_LLM_MODEL: REASONING_MODEL },
      FALLBACK,
    );
    expect(resolved.model).toBe(REASONING_MODEL);
  });

  it("fails closed on a malformed policy rather than reviewing with defaults", () => {
    expect(() =>
      resolveReviewRequestPolicy({ DF_LLM_THINKING_LEVEL: "highish" }, FALLBACK),
    ).toThrow(EnvConfigError);
    expect(() =>
      resolveReviewRequestPolicy({ DF_LLM_MAX_STEPS: "many" }, FALLBACK),
    ).toThrow(EnvConfigError);
  });
});