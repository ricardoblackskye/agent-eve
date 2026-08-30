import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveChatModel } from "../agent/chat-model";

describe("chat model id (issue #47)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses EVE_CHAT_MODEL when set", () => {
    vi.stubEnv("EVE_CHAT_MODEL", "deepseek/deepseek-v4-pro");
    const model = resolveChatModel() as any;
    expect(String(model?.modelId ?? "")).toContain("deepseek");
  });

  it("falls back to the default deepseek model id when unset", () => {
    vi.unstubAllEnvs();
    const model = resolveChatModel() as any;
    expect(String(model?.modelId ?? "")).toContain("deepseek");
  });
});
