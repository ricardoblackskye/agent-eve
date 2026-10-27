/**
 * #498 - the reservation price floor.
 *
 * The floor exists because a hand-maintained ceiling sitting below the dearest provider rate
 * under-reserves silently. These tests pin the observation record and the staleness arithmetic; the
 * wiring of the floor into `resolvePrice` is covered by cost-budget.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  PRICE_FLOOR_TTL_DAYS,
  PRICE_FLOOR_VERIFIED_AT,
  floorAgeDays,
  floorFor,
  isFloorStale,
  observedDearest,
} from "../../agent/lib/dark-factory/model-price-floor";

const DAY_MS = 24 * 60 * 60 * 1000;
const verifiedAt = new Date(`${PRICE_FLOOR_VERIFIED_AT}T00:00:00.000Z`);

describe("#498 the observed-dearest floor", () => {
  it("records at least one model, so the guard cannot pass vacuously", () => {
    expect(Object.keys(observedDearest).length).toBeGreaterThanOrEqual(1);
  });

  it("records the dearest rate actually seen for the default model", () => {
    const floor = floorFor("deepseek/deepseek-v4.1-flash");
    expect(floor).toBeDefined();
    expect(floor?.inputUsdPer1k).toBe(0.0006);
    expect(floor?.outputUsdPer1k).toBe(0.006727487);
    expect(floor?.providers).toBeGreaterThanOrEqual(1);
  });

  it("normalises the lookup the same way resolvePrice does", () => {
    expect(floorFor("  DeepSeek/DeepSeek-V4.1-Flash  ")).toEqual(
      floorFor("deepseek/deepseek-v4.1-flash"),
    );
  });

  it("returns undefined for a model it never saw, rather than inventing a floor", () => {
    expect(floorFor("some/unknown-model")).toBeUndefined();
    expect(floorFor(null)).toBeUndefined();
    expect(floorFor(undefined)).toBeUndefined();
    expect(floorFor("   ")).toBeUndefined();
  });

  it("reports every recorded rate as finite and non-negative", () => {
    for (const [id, observed] of Object.entries(observedDearest)) {
      expect(Number.isFinite(observed.inputUsdPer1k), `${id} input`).toBe(true);
      expect(Number.isFinite(observed.outputUsdPer1k), `${id} output`).toBe(true);
      expect(observed.inputUsdPer1k, `${id} input`).toBeGreaterThanOrEqual(0);
      expect(observed.outputUsdPer1k, `${id} output`).toBeGreaterThanOrEqual(0);
      expect(observed.providers, `${id} providers`).toBeGreaterThanOrEqual(1);
    }
  });

  it("measures age from the verification date, not from process start", () => {
    expect(floorAgeDays(verifiedAt)).toBe(0);
    expect(floorAgeDays(new Date(verifiedAt.getTime() + 7 * DAY_MS))).toBe(7);
  });

  it("is NOT stale at exactly the TTL, and stale the day after", () => {
    const exactlyTtl = new Date(verifiedAt.getTime() + PRICE_FLOOR_TTL_DAYS * DAY_MS);
    const oneDayPast = new Date(
      verifiedAt.getTime() + (PRICE_FLOOR_TTL_DAYS + 1) * DAY_MS,
    );
    expect(isFloorStale(exactlyTtl)).toBe(false);
    expect(isFloorStale(oneDayPast)).toBe(true);
  });
});
