import { describe, it, expect, vi } from "vitest";

// Mock the eve module
vi.mock("eve", () => ({
  defineAgent: (params: any) => params,
}));

// Mock the @ai-sdk/openai module
vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({
    chat: (model: any) => ({ model }),
  }),
}));

// Import the agent after mocking
const prReviewerAgent = await import("../agent/subagents/pr-reviewer/agent");

describe("PR Reviewer Agent", () => {
  it("should exist and have a description", () => {
    expect(prReviewerAgent.default).toBeDefined();
    expect(prReviewerAgent.default.description).toBe(
      "You are a senior software engineer reviewing this code diff. Look for architectural anti-patterns, security risks, and off-by-one errors."
    );
  });
});