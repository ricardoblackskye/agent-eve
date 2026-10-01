import { describe, expect, it } from "vitest";
import { buildLlmPolicyReport } from "../../agent/lib/dark-factory/llm-policy-query";
import {
  DEFAULT_MAX_STEPS,
  DEFAULT_THINKING_LEVEL,
  EnvConfigError,
} from "../../agent/lib/dark-factory/llm-policy";

const SURFACES = [
  {
    surface: "orchestrator" as const,
    defaultModel: "deepseek/deepseek-v4.1-flash",
  },
  { surface: "worker" as const, defaultModel: "deepseek/deepseek-v4.1-flash" },
  { surface: "pr-review" as const, defaultModel: "deepseek/deepseek-chat" },
];

describe("buildLlmPolicyReport", () => {
  it("reports the documented defaults and marks every surface legacy when unconfigured", () => {
    const report = buildLlmPolicyReport({}, SURFACES);

    expect(report.configured).toBe(false);
    expect(report.thinkingLevel).toBe(DEFAULT_THINKING_LEVEL);
    expect(report.maxSteps).toBe(DEFAULT_MAX_STEPS);
    expect(report).not.toHaveProperty("model");
    expect(report.surfaces).toHaveLength(3);
    for (const surface of report.surfaces) {
      expect(surface.legacy).toBe(true);
      expect(surface.applied).toBe(false);
    }
    // Each surface keeps its own model when no policy overrides it.
    expect(report.surfaces[2].model).toBe("deepseek/deepseek-chat");
  });

  it("reports the effective policy once configured", () => {
    const report = buildLlmPolicyReport(
      { DF_LLM_THINKING_LEVEL: "high", DF_LLM_MAX_STEPS: "6" },
      SURFACES,
    );

    expect(report.configured).toBe(true);
    expect(report.thinkingLevel).toBe("high");
    expect(report.maxSteps).toBe(6);
    expect(report.surfaces.every((s) => s.legacy === false)).toBe(true);
  });

  it("marks a surface that cannot reason as not applied, with a reason", () => {
    const report = buildLlmPolicyReport(
      { DF_LLM_THINKING_LEVEL: "high" },
      SURFACES,
    );

    const prReview = report.surfaces.find((s) => s.surface === "pr-review");
    const orchestrator = report.surfaces.find(
      (s) => s.surface === "orchestrator",
    );

    // The plain chat model degrades; the reasoning model applies.
    expect(prReview?.applied).toBe(false);
    expect(prReview?.reason).toMatch(/reasoning/i);
    expect(orchestrator?.applied).toBe(true);
    expect(orchestrator?.reason).toBeUndefined();
  });

  it("applies a policy model override to every surface", () => {
    const report = buildLlmPolicyReport(
      { DF_LLM_MODEL: "deepseek/deepseek-v4.1-flash" },
      SURFACES,
    );

    expect(report.model).toBe("deepseek/deepseek-v4.1-flash");
    for (const surface of report.surfaces) {
      expect(surface.model).toBe("deepseek/deepseek-v4.1-flash");
      expect(surface.applied).toBe(true);
    }
  });

  it("reports a thinking level of off as applied but sends nothing", () => {
    const report = buildLlmPolicyReport(
      { DF_LLM_THINKING_LEVEL: "off" },
      SURFACES,
    );

    expect(report.thinkingLevel).toBe("off");
    for (const surface of report.surfaces) {
      expect(surface.applied).toBe(true);
      expect(surface.reason).toBeUndefined();
    }
  });

  it("fails closed on a malformed policy rather than reporting defaults", () => {
    expect(() =>
      buildLlmPolicyReport({ DF_LLM_MAX_STEPS: "many" }, SURFACES),
    ).toThrow(EnvConfigError);
  });

  it("carries no secret material", () => {
    const report = buildLlmPolicyReport(
      {
        DF_LLM_THINKING_LEVEL: "high",
        OPENROUTER_API_KEY: "sk-must-not-appear",
        DF_LLM_DATABASE_URL: "postgres://user:pw@host/db",
      },
      SURFACES,
    );

    const serialised = JSON.stringify(report);
    expect(serialised).not.toMatch(/sk-must-not-appear/);
    expect(serialised).not.toMatch(/postgres:\/\//);
    expect(serialised).not.toMatch(/API_KEY/);
  });
});
