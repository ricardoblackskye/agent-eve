import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as modelConfig from "../agent/model-config";
import { modelPriceTable, resolvePrice } from "../agent/lib/dark-factory/cost-budget";
import {
  ceilingsBelowObserved,
  parsePriceReceipt,
  unverifiedPriceModels,
} from "./support/openrouter-price-receipt";

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
const RECEIPT_PATH = resolve(
  process.cwd(),
  "tests/support/openrouter-price-receipt.json",
);

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
  "deepseek/deepseek-v4.1-flash": {
    inputUsdPer1k: 0.0007,
    outputUsdPer1k: 0.0084,
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


/**
 * #494 — the ceilings must cover the dearest rate we have RECORDED seeing.
 *
 * Hermetic: nothing here touches the network. The live comparison is `npm run prices:check`,
 * driven by the scheduled Price Drift workflow, because a unit test asserting our constant
 * against somebody else's changing number goes red for reasons no PR can fix. It did exactly
 * that three times in one day on `main`.
 *
 * This still asserts something real: lower a ceiling below the dearest rate on record, or
 * leave a declared model out of the receipt, and this fails.
 */
describe("#494 the shipped ceilings cover the recorded dearest provider rate", () => {
  const receiptText = readFileSync(RECEIPT_PATH, "utf8");

  it("parses the committed receipt", () => {
    const parsed = parsePriceReceipt(receiptText);
    expect(parsed.kind, parsed.kind === "malformed" ? parsed.reason : "").toBe("ok");
  });

  it("records every declared model id (guards against a vacuous pass)", () => {
    const parsed = parsePriceReceipt(receiptText);
    if (parsed.kind !== "ok") throw new Error(parsed.reason);
    expect(Object.keys(parsed.receipt.observedDearest).length).toBeGreaterThanOrEqual(1);
    expect(unverifiedPriceModels(declaredModelIds(), parsed.receipt)).toEqual([]);
  });

  it("covers the dearest observed rate on every axis", () => {
    const parsed = parsePriceReceipt(receiptText);
    if (parsed.kind !== "ok") throw new Error(parsed.reason);
    expect(ceilingsBelowObserved(modelPriceTable, parsed.receipt)).toEqual([]);
  });

  it("rejects a malformed receipt rather than trusting it", () => {
    expect(parsePriceReceipt("{not json").kind).toBe("malformed");
    expect(
      parsePriceReceipt(JSON.stringify({ verifiedAt: "nope", source: "s", observedDearest: {} })).kind,
    ).toBe("malformed");
    expect(
      parsePriceReceipt(
        JSON.stringify({
          verifiedAt: "2026-01-01",
          source: "s",
          observedDearest: { "a/b": { inputUsdPer1k: 1, outputUsdPer1k: "x", providers: 1 } },
        }),
      ).kind,
    ).toBe("malformed");
  });

  it("detects a ceiling that has been lowered below the recorded rate", () => {
    const lowered = { ...modelPriceTable, "a/b": { inputUsdPer1k: 0, outputUsdPer1k: 0 } };
    const problems = ceilingsBelowObserved(lowered, {
      verifiedAt: "2026-01-01",
      source: "s",
      observedDearest: { "a/b": { inputUsdPer1k: 5, outputUsdPer1k: 9, providers: 2 } },
    });
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain("a/b");
  });
});
