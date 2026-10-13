import { describe, expect, it, vi } from "vitest";
import * as modelConfig from "../agent/model-config";
import { resolvePrice } from "../agent/lib/dark-factory/cost-budget";

/**
 * #335 — the shipped models must be PRICED, and priced as reservation CEILINGS.
 *
 * `modelPriceTable` is what `admit()` reserves against before a call. An unpriced model means the
 * governor refuses the call (fail-closed), so an unpriced SHIPPED model means cost governance cannot
 * be switched on at all. That is what happened: the table still carried `deepseek/deepseek-chat`
 * (the pre-#121 default) and neither model the agent actually ships.
 *
 * The guard is written over the MODULE's exports, so a future `*_MODEL_ID` is covered automatically
 * rather than only the two that exist today.
 */
const EXPECTED_CEILINGS: Record<
  string,
  { inputUsdPer1k: number; outputUsdPer1k: number }
> = {
  // Maximum published OpenRouter provider price per axis, measured 2026-10-13 (see ADR 0027).
  "deepseek/deepseek-v4.1-flash": {
    inputUsdPer1k: 0.0006,
    outputUsdPer1k: 0.0024,
  },
  "deepseek/deepseek-v4-pro": {
    inputUsdPer1k: 0.00191,
    outputUsdPer1k: 0.0105,
  },
};

/** Every model id the config module declares, whatever it is called. */
function declaredModelIds(): string[] {
  return Object.entries(modelConfig)
    .filter(
      ([name, value]) =>
        name.endsWith("_MODEL_ID") && typeof value === "string",
    )
    .map(([, value]) => value as string);
}

describe("#335 shipped models are priced", () => {
  it("finds the declared model ids (guards against a vacuous pass)", () => {
    const ids = declaredModelIds();
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids).toContain(modelConfig.DEFAULT_MODEL_ID);
    expect(ids).toContain(modelConfig.FALLBACK_MODEL_ID);
  });

  it("prices EVERY declared model id — an unpriced shipped model refuses every call", () => {
    for (const id of declaredModelIds()) {
      expect(
        resolvePrice(id),
        `${id} has no price in modelPriceTable`,
      ).not.toBeNull();
    }
  });

  it("prices them as the documented ceilings", () => {
    for (const [id, expected] of Object.entries(EXPECTED_CEILINGS)) {
      const price = resolvePrice(id);
      expect(price, `${id} has no price`).not.toBeNull();
      expect(price?.inputUsdPer1k, `${id} input`).toBeCloseTo(
        expected.inputUsdPer1k,
        10,
      );
      expect(price?.outputUsdPer1k, `${id} output`).toBeCloseTo(
        expected.outputUsdPer1k,
        10,
      );
    }
  });

  it("honours the documented DF_MODEL_PRICE_<stableId> override, which beats the table", () => {
    // The stable id is the model id lowercased with every non-alphanumeric replaced by "_".
    // Documented in .env.example — this test keeps that documentation honest.
    vi.stubEnv("DF_MODEL_PRICE_deepseek_deepseek_v4_1_flash", "0.5,1.5");
    try {
      expect(resolvePrice("deepseek/deepseek-v4.1-flash")).toEqual({
        inputUsdPer1k: 0.5,
        outputUsdPer1k: 1.5,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
