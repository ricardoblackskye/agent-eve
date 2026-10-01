// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LlmPolicyPanel } from "../../app/dark-factory/ui/llm-policy-panel";
import type { LlmPolicyReport } from "../../agent/lib/dark-factory/llm-policy-query";

const configured: LlmPolicyReport = {
  configured: true,
  thinkingLevel: "high",
  maxSteps: 6,
  surfaces: [
    {
      surface: "orchestrator",
      model: "deepseek/deepseek-v4.1-flash",
      thinkingLevel: "high",
      applied: true,
      legacy: false,
    },
    {
      surface: "pr-review",
      model: "deepseek/deepseek-chat",
      thinkingLevel: "high",
      applied: false,
      reason:
        "deepseek/deepseek-chat does not support provider-side reasoning; thinking level 'high' was not applied.",
      legacy: false,
    },
  ],
};

const unconfigured: LlmPolicyReport = {
  configured: false,
  thinkingLevel: "medium",
  maxSteps: 10,
  surfaces: [
    {
      surface: "orchestrator",
      model: "deepseek/deepseek-v4.1-flash",
      thinkingLevel: "medium",
      applied: false,
      legacy: true,
    },
  ],
};

describe("LlmPolicyPanel", () => {
  it("shows the effective policy once configured", () => {
    render(
      <LlmPolicyPanel
        report={configured}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("orchestrator")).toBeTruthy();
  });

  it("shows the unconfigured state distinctly rather than as a value", () => {
    render(
      <LlmPolicyPanel
        report={unconfigured}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText(/no policy configured/i)).toBeTruthy();
  });

  it("surfaces a degraded surface with its reason", () => {
    render(
      <LlmPolicyPanel
        report={configured}
        loading={false}
        error={null}
        onRefresh={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/does not support provider-side reasoning/i),
    ).toBeTruthy();
  });

  it("surfaces the error and refreshes on demand", () => {
    const onRefresh = vi.fn();
    render(
      <LlmPolicyPanel
        report={null}
        loading={false}
        error="DF_LLM_MAX_STEPS must be a positive integer"
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByRole("alert").textContent).toMatch(/positive integer/);
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state before the first report arrives", () => {
    render(
      <LlmPolicyPanel report={null} loading error={null} onRefresh={vi.fn()} />,
    );

    expect(screen.getByText(/loading/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
