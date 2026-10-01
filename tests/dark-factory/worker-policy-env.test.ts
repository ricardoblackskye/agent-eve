import { describe, expect, it } from "vitest";
import { buildWorkerPolicyEnv } from "../../agent/lib/dark-factory/worker-policy-env";
import {
  EnvConfigError,
  POLICY_MAX_STEPS_VAR,
  POLICY_MODEL_VAR,
  POLICY_THINKING_LEVEL_VAR,
  resolveLlmPolicy,
} from "../../agent/lib/dark-factory/llm-policy";

describe("buildWorkerPolicyEnv", () => {
  it("is null when no policy is configured, leaving the sandbox unchanged", () => {
    expect(buildWorkerPolicyEnv({})).toBeNull();
    expect(buildWorkerPolicyEnv({ DF_LLM_THINKING_LEVEL: "   " })).toBeNull();
  });

  it("injects the canonical policy variables when one is configured", () => {
    const built = buildWorkerPolicyEnv({
      DF_LLM_THINKING_LEVEL: "high",
      DF_LLM_MAX_STEPS: "7",
    });

    expect(built).not.toBeNull();
    expect(built?.thinkingLevel).toBe("high");
    expect(built?.maxSteps).toBe(7);
    expect(built?.env).toEqual({
      [POLICY_THINKING_LEVEL_VAR]: "high",
      [POLICY_MAX_STEPS_VAR]: "7",
    });
  });

  it("injects the model only when the policy carries one", () => {
    const withModel = buildWorkerPolicyEnv({
      DF_LLM_THINKING_LEVEL: "low",
      DF_LLM_MODEL: "deepseek/deepseek-chat",
    });
    expect(withModel?.env[POLICY_MODEL_VAR]).toBe("deepseek/deepseek-chat");

    const without = buildWorkerPolicyEnv({ DF_LLM_THINKING_LEVEL: "low" });
    expect(without?.env).not.toHaveProperty(POLICY_MODEL_VAR);
  });

  it("injects no secret: no API key or credential ever reaches the sandbox", () => {
    const built = buildWorkerPolicyEnv({
      DF_LLM_THINKING_LEVEL: "high",
      OPENROUTER_API_KEY: "sk-should-never-be-injected",
      DF_USAGE_DATABASE_URL: "postgres://user:pw@host/db",
    });

    const serialised = JSON.stringify(built);
    expect(serialised).not.toMatch(/sk-should-never-be-injected/);
    expect(serialised).not.toMatch(/postgres:\/\//);
    expect(serialised).not.toMatch(/API_KEY/);
  });

  it("round-trips: the injected env resolves back to the same policy", () => {
    const source = {
      DF_LLM_THINKING_LEVEL: "medium",
      DF_LLM_MAX_STEPS: "12",
      DF_LLM_MODEL: "deepseek/deepseek-chat",
    };
    const built = buildWorkerPolicyEnv(source);
    expect(built).not.toBeNull();

    // A sandbox running resolveLlmPolicy on the injected env must agree.
    expect(resolveLlmPolicy(built?.env ?? {})).toEqual(
      resolveLlmPolicy(source),
    );
  });

  it("fails closed on a malformed policy rather than injecting defaults", () => {
    expect(() => buildWorkerPolicyEnv({ DF_LLM_MAX_STEPS: "many" })).toThrow(
      EnvConfigError,
    );
    expect(() =>
      buildWorkerPolicyEnv({ DF_LLM_THINKING_LEVEL: "highish" }),
    ).toThrow(EnvConfigError);
  });
});
