/**
 * Pure model-resolution policy (issue #121 / #122).
 *
 * `resolveModelId` decides which model id an agent/subagent uses. The policy:
 *  - env override wins when present,
 *  - otherwise the primary (new) model,
 *  - when the primary is unreachable AND a fallback is configured, use the
 *    fallback — but NEVER silently revert to the old model unless a fallback is
 *    explicitly provided (matches the story AC: "no fallback to the previous
 *    model occurs unless the new model is unreachable and a fallback is
 *    explicitly configured").
 *
 * This is the foundational, provider-agnostic resolver so future model swaps
 * only change `model-config.ts`.
 */
import { describe, it, expect } from "vitest";
import { resolveModelId, DEFAULT_MODEL_ID, FALLBACK_MODEL_ID } from "../agent/model-config";

describe("resolveModelId (model swap foundation)", () => {
  it("defaults to the new primary model when nothing is set", () => {
    expect(resolveModelId({})).toBe(DEFAULT_MODEL_ID);
    expect(DEFAULT_MODEL_ID).toBe("deepseek/deepseek-v4.1-flash");
  });

  it("honours an explicit env override over the primary", () => {
    expect(resolveModelId({ envOverride: "anthropic/claude-3.5-sonnet" })).toBe(
      "anthropic/claude-3.5-sonnet",
    );
  });

  it("falls back to the configured fallback only when primary is unreachable", () => {
    expect(
      resolveModelId({ fallback: FALLBACK_MODEL_ID, unreachable: true }),
    ).toBe(FALLBACK_MODEL_ID);
    expect(FALLBACK_MODEL_ID).toBe("deepseek/deepseek-v4-pro");
  });

  it("does NOT silently revert to the old model when unreachable but no fallback is configured", () => {
    // Without an explicit fallback, an unreachable primary still returns the
    // primary — the caller must decide how to handle the outage. It must never
    // quietly serve the previous model.
    expect(resolveModelId({ unreachable: true })).toBe(DEFAULT_MODEL_ID);
  });

  it("prefers env override even when primary is unreachable (override is authoritative)", () => {
    expect(
      resolveModelId({
        envOverride: "openai/gpt-4o-mini",
        fallback: FALLBACK_MODEL_ID,
        unreachable: true,
      }),
    ).toBe("openai/gpt-4o-mini");
  });

  it("uses the primary (not fallback) when reachable", () => {
    expect(
      resolveModelId({ fallback: FALLBACK_MODEL_ID, unreachable: false }),
    ).toBe(DEFAULT_MODEL_ID);
  });
});
