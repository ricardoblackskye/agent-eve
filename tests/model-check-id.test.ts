import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveChatModel } from "../agent/chat-model";
import { DEFAULT_MODEL_ID } from "../agent/model-config";

describe("chat model id (issue #47, #121)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses EVE_CHAT_MODEL when set", () => {
    vi.stubEnv("EVE_CHAT_MODEL", "deepseek/deepseek-v4.1-flash");
    const model = resolveChatModel() as any;
    expect(String(model?.modelId ?? "")).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("defaults to the exact new DeepSeek V4.1 Flash id when unset", () => {
    vi.unstubAllEnvs();
    const model = resolveChatModel() as any;
    expect(String(model?.modelId ?? "")).toBe(DEFAULT_MODEL_ID);
    expect(DEFAULT_MODEL_ID).toBe("deepseek/deepseek-v4.1-flash");
  });
});
