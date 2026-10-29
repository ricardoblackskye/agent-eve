import { describe, expect, it, vi } from "vitest";
import * as modelConfig from "../agent/model-config";
import { modelPriceTable, resolvePrice } from "../agent/lib/dark-factory/cost-budget";
import {
  floorFor,
  observedDearest,
} from "../agent/lib/dark-factory/model-price-floor";

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
  // The ceilings we SHIP, pinned so a silent table edit fails here.
  //
  // These are deliberately ABOVE the dearest published provider rate rather than equal to it. The
  // dearest measured on 2026-10-26 was 0.0006 input / 0.005559908 output for v4.1-flash, and the
  // catalog moves — that output figure rose ~33% within one session. A ceiling pinned exactly to the
  // live maximum goes stale and then under-reserves, which is #494. Comparing the table against the
  // LIVE catalog is the contract test's job; this one only pins what we ship (see ADR 0027).
  //
  // #499 / ADR 0079: the shipped figure is now derived from the PEER distribution rather than from one endpoint.
  // The 0.02 that stood here was sized for a provider charging 0.015863057 - 18.9x the second-dearest - and that
  // provider has since left the catalog, so 0.02 was reserving 8.3x what any reachable provider charges. The
  // refresh path now adopts at most 3 x p90, and the ceiling sits at that cap x 1.25 (0.0045): above what the rule
  // can adopt, so it does not bind the reservation, with a margin for a rise between verifications.
  "deepseek/deepseek-v4.1-flash": {
    inputUsdPer1k: 0.0007,
    outputUsdPer1k: 0.0045,
  },
  "deepseek/deepseek-v4-pro": {
    inputUsdPer1k: 0.0021,
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
      // #498 - assert the TABLE, not resolvePrice(id). resolvePrice now returns the RESERVATION
      // price: the higher of the table and the observed-dearest floor. It is therefore no longer
      // the ceiling, and comparing it here would conflate "the number we ship" with "the number we
      // reserve". This case exists to pin the shipped number, so a silent table edit still fails.
      const price = modelPriceTable[id];
      expect(price, `${id} has no price in modelPriceTable`).toBeDefined();
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


/**
 * #498 - the commit-time half of AC3.
 *
 * The runtime floor SUBSTITUTES for a stale ceiling, which keeps the reservation safe but
 * leaves the shipped number wrong: the table would keep claiming a rate the catalog left
 * behind, and the operator reading it would have no idea. This guard is what stops the table
 * silently rotting, by failing the build the moment a shipped ceiling sits below the dearest
 * rate we have actually verified.
 *
 * Hermetic: no network. The live half is `npm run prices:check`, driven by the scheduled
 * Price Drift workflow.
 */
describe("#498 the shipped ceilings keep pace with the recorded floor", () => {
  it("records every declared model id, so a new model cannot skip the guard", () => {
    const missing = declaredModelIds().filter((id) => floorFor(id) === undefined);
    expect(
      missing,
      `declared but unrecorded in the price floor: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("holds every shipped ceiling at or above the recorded dearest rate", () => {
    const recorded = Object.keys(observedDearest);
    expect(recorded.length).toBeGreaterThanOrEqual(1);
    for (const id of recorded) {
      const observed = observedDearest[id];
      const entry = modelPriceTable[id];
      expect(entry, `${id}: no ceiling in modelPriceTable`).toBeDefined();
      expect(
        entry?.inputUsdPer1k,
        `${id} input: shipped ceiling ${entry?.inputUsdPer1k} is below the recorded dearest ${observed.inputUsdPer1k}`,
      ).toBeGreaterThanOrEqual(observed.inputUsdPer1k);
      expect(
        entry?.outputUsdPer1k,
        `${id} output: shipped ceiling ${entry?.outputUsdPer1k} is below the recorded dearest ${observed.outputUsdPer1k}`,
      ).toBeGreaterThanOrEqual(observed.outputUsdPer1k);
    }
  });
});
