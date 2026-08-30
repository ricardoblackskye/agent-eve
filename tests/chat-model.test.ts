import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveChatModel } from "../agent/chat-model";

describe("chat model selection (issue #44)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the real model when OPENROUTER_API_KEY is set", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-...");
    const model = resolveChatModel() as any;
    // Real OpenRouter models report provider "openrouter"; mock reports "eve-mock".
    expect(model?.provider).not.toBe("eve-mock");
  });

  it("falls back to the mock model when OPENROUTER_API_KEY is unset", () => {
    vi.unstubAllEnvs();
    const model = resolveChatModel() as any;
    expect(model?.provider).toBe("eve-mock");
  });
});
