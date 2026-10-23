import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveChatModelWithId } from "../agent/chat-model";
import { DEFAULT_MODEL_ID } from "../agent/model-config";
import { resolvePrice } from "../agent/lib/dark-factory/cost-budget";

describe("model id travels with the model (issue #400)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports the canonical default id when EVE_CHAT_MODEL is unset", () => {
    vi.unstubAllEnvs();
    const { modelId } = resolveChatModelWithId();
    expect(modelId).toBe(DEFAULT_MODEL_ID);
  });

  it("reports the env override when it is set", () => {
    vi.stubEnv("EVE_CHAT_MODEL", "deepseek/deepseek-v4-pro");
    const { modelId } = resolveChatModelWithId();
    expect(modelId).toBe("deepseek/deepseek-v4-pro");
  });

  it("lets an explicit id beat the env var", () => {
    vi.stubEnv("EVE_CHAT_MODEL", "deepseek/deepseek-v4-pro");
    const { modelId } = resolveChatModelWithId({ modelId: "deepseek/deepseek-v4.1-flash" });
    expect(modelId).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("builds the model from the id it reports (anti-drift, mock path)", () => {
    vi.unstubAllEnvs();
    const pair = resolveChatModelWithId();
    // The model carries its own id; it must equal the id handed to the caller.
    expect(String((pair.model as { modelId?: string }).modelId ?? "")).toBe(pair.modelId);
  });

  it("builds the model from the id it reports (anti-drift, provider path)", () => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key-not-used");
    const pair = resolveChatModelWithId();
    expect(String((pair.model as { modelId?: string }).modelId ?? "")).toBe(pair.modelId);
  });

  it("never reports an id that the price table cannot price", () => {
    vi.unstubAllEnvs();
    const { modelId } = resolveChatModelWithId();
    // An unpriced id makes the gate settle at the reservation instead of at usage.
    expect(resolvePrice(modelId)).not.toBeNull();
  });
});
