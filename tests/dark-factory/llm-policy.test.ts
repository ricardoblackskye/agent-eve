import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_THINKING_LEVEL,
  EnvConfigError,
  isLlmPolicyConfigured,
  MAX_POLICY_STEPS,
  resolveLlmPolicy,
  resolvePolicyMaxSteps,
  THINKING_LEVELS,
} from "../../agent/lib/dark-factory/llm-policy";

describe("resolveLlmPolicy", () => {
  it("applies the documented defaults when nothing is set", () => {
    const policy = resolveLlmPolicy({});
    expect(policy.thinkingLevel).toBe(DEFAULT_THINKING_LEVEL);
    expect(policy.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(policy).not.toHaveProperty("model");
  });

  it("treats blank values as unset rather than malformed", () => {
    const policy = resolveLlmPolicy({
      DF_LLM_THINKING_LEVEL: "   ",
      DF_LLM_MAX_STEPS: "",
      DF_LLM_MODEL: "  ",
    });
    expect(policy.thinkingLevel).toBe(DEFAULT_THINKING_LEVEL);
    expect(policy.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(policy).not.toHaveProperty("model");
  });

  it("accepts every supported thinking level", () => {
    for (const level of THINKING_LEVELS) {
      expect(
        resolveLlmPolicy({ DF_LLM_THINKING_LEVEL: level }).thinkingLevel,
      ).toBe(level);
    }
  });

  it("is case- and whitespace-insensitive for the level", () => {
    expect(
      resolveLlmPolicy({ DF_LLM_THINKING_LEVEL: "  HIGH  " }).thinkingLevel,
    ).toBe("high");
    expect(
      resolveLlmPolicy({ DF_LLM_THINKING_LEVEL: "Off" }).thinkingLevel,
    ).toBe("off");
  });

  it("FAILS CLOSED on a malformed thinking level, never a silent default", () => {
    for (const bad of ["medium-high", "highish", "2", "true"]) {
      expect(() => resolveLlmPolicy({ DF_LLM_THINKING_LEVEL: bad })).toThrow(
        EnvConfigError,
      );
    }
  });

  it("accepts a valid step count", () => {
    expect(resolveLlmPolicy({ DF_LLM_MAX_STEPS: "7" }).maxSteps).toBe(7);
    expect(resolveLlmPolicy({ DF_LLM_MAX_STEPS: " 25 " }).maxSteps).toBe(25);
    expect(resolveLlmPolicy({ DF_LLM_MAX_STEPS: "1" }).maxSteps).toBe(1);
  });

  it("FAILS CLOSED on a non-digit, zero, negative or fractional step count", () => {
    for (const bad of ["abc", "0", "-1", "2.5", "3.0", "1e3", "10px"]) {
      expect(() => resolveLlmPolicy({ DF_LLM_MAX_STEPS: bad })).toThrow(
        EnvConfigError,
      );
    }
  });

  it("rejects an out-of-range step count", () => {
    expect(() =>
      resolveLlmPolicy({ DF_LLM_MAX_STEPS: String(MAX_POLICY_STEPS + 1) }),
    ).toThrow(EnvConfigError);
    // The exact upper boundary is accepted.
    expect(
      resolveLlmPolicy({ DF_LLM_MAX_STEPS: String(MAX_POLICY_STEPS) }).maxSteps,
    ).toBe(MAX_POLICY_STEPS);
  });

  it("carries an optional model override", () => {
    expect(
      resolveLlmPolicy({ DF_LLM_MODEL: "deepseek/deepseek-chat" }).model,
    ).toBe("deepseek/deepseek-chat");
    expect(
      resolveLlmPolicy({ DF_LLM_MODEL: "  deepseek/deepseek-chat  " }).model,
    ).toBe("deepseek/deepseek-chat");
  });

  it("names the offending variable in the error", () => {
    expect(() => resolveLlmPolicy({ DF_LLM_MAX_STEPS: "nope" })).toThrow(
      /DF_LLM_MAX_STEPS/,
    );
    expect(() => resolveLlmPolicy({ DF_LLM_THINKING_LEVEL: "nope" })).toThrow(
      /DF_LLM_THINKING_LEVEL/,
    );
  });

  it("reports the config-error code so callers can catch it distinctly", () => {
    try {
      resolveLlmPolicy({ DF_LLM_MAX_STEPS: "nope" });
      throw new Error("expected resolveLlmPolicy to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvConfigError);
      expect((error as EnvConfigError).code).toBe("ERR_ENV_CONFIG");
    }
  });
});

describe("isLlmPolicyConfigured", () => {
  it("is false when no policy variable carries a value, so defaults apply", () => {
    expect(isLlmPolicyConfigured({})).toBe(false);
    expect(isLlmPolicyConfigured({ DF_LLM_THINKING_LEVEL: "   " })).toBe(false);
    expect(isLlmPolicyConfigured({ DF_LLM_MAX_STEPS: "" })).toBe(false);
    expect(isLlmPolicyConfigured({ DF_LLM_MODEL: "  " })).toBe(false);
  });

  it("is true when any policy variable is set", () => {
    expect(isLlmPolicyConfigured({ DF_LLM_THINKING_LEVEL: "high" })).toBe(true);
    expect(isLlmPolicyConfigured({ DF_LLM_MAX_STEPS: "5" })).toBe(true);
    expect(
      isLlmPolicyConfigured({ DF_LLM_MODEL: "deepseek/deepseek-chat" }),
    ).toBe(true);
  });
});

describe("resolvePolicyMaxSteps", () => {
  it("returns the fallback when no policy is configured", () => {
    expect(resolvePolicyMaxSteps({}, 10)).toBe(10);
    expect(resolvePolicyMaxSteps({ DF_LLM_THINKING_LEVEL: "   " }, 3)).toBe(3);
  });

  it("returns the policy's step bound once configured", () => {
    expect(resolvePolicyMaxSteps({ DF_LLM_MAX_STEPS: "8" }, 10)).toBe(8);
    // A thinking level alone still activates the policy, using the default bound.
    expect(resolvePolicyMaxSteps({ DF_LLM_THINKING_LEVEL: "high" }, 10)).toBe(
      DEFAULT_MAX_STEPS,
    );
  });

  it("fails closed on a malformed policy rather than returning the fallback", () => {
    expect(() =>
      resolvePolicyMaxSteps({ DF_LLM_MAX_STEPS: "many" }, 10),
    ).toThrow(EnvConfigError);
  });
});
