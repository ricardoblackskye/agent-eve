/**
 * #498 - the reservation price floor.
 *
 * The floor exists because a hand-maintained ceiling sitting below the dearest provider rate
 * under-reserves silently. These tests pin the observation record and the staleness arithmetic; the
 * wiring of the floor into `resolvePrice` is covered by cost-budget.test.ts.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PRICE_FLOOR_TTL_DAYS,
  PRICE_FLOOR_VERIFIED_AT,
  buildPriceFloorRecord,
  PRICE_OUTLIER_MULTIPLE,
  capRate,
  ceilingsBelowObserved,
  distributionOf,
  floorAgeDays,
  floorFor,
  isFloorStale,
  observedDearest,
  PRICE_FLOOR_DATA_RELATIVE_PATH,
  priceFloorRecord,
  renderPriceFloorModule,
  stalenessNotice,
  unverifiedPriceModels,
} from "../../agent/lib/dark-factory/model-price-floor";
import { modelPriceTable } from "../../agent/lib/dark-factory/cost-budget";

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
    expect(floor?.outputUsdPer1k).toBe(0.015863057);
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

/**
 * These moved here from the retired test-side receipt (#498 Task 5). They are SHIPPED functions now -
 * the refresh script depends on them - so they are covered where they live rather than where they
 * used to be borrowed from.
 */
describe("#498 the shipped record helpers", () => {
  it("builds a dated record from a fresh reading", () => {
    const built = buildPriceFloorRecord(
      { "a/b": { inputUsdPer1k: 1, outputUsdPer1k: 2, providers: 3 } },
      "https://example.invalid/<id>",
      new Date("2026-05-04T23:30:00.000Z"),
    );
    expect(built.verifiedAt).toBe("2026-05-04");
    expect(built.source).toBe("https://example.invalid/<id>");
    expect(built.observedDearest["a/b"].providers).toBe(3);
  });

  it("reports every declared model that has no recorded observation", () => {
    expect(unverifiedPriceModels(["deepseek/deepseek-v4.1-flash"])).toEqual([]);
    expect(unverifiedPriceModels(["deepseek/deepseek-v4.1-flash", "nobody/nothing"])).toEqual([
      "nobody/nothing",
    ]);
  });

  const oneModel = {
    verifiedAt: "2026-01-01",
    source: "s",
    observedDearest: {
      "deepseek/deepseek-v4.1-flash": { inputUsdPer1k: 0.5, outputUsdPer1k: 0.75, providers: 4 },
    },
  };

  it("reports no ceiling problem when the table already covers the observation", () => {
    expect(
      ceilingsBelowObserved(
        { "deepseek/deepseek-v4.1-flash": { inputUsdPer1k: 99, outputUsdPer1k: 99 } },
        oneModel,
      ),
    ).toEqual([]);
  });

  it("names the axis and both numbers when a ceiling falls below the observation", () => {
    const problems = ceilingsBelowObserved(
      { "deepseek/deepseek-v4.1-flash": { inputUsdPer1k: 0, outputUsdPer1k: 0 } },
      oneModel,
    );
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain("input");
    expect(problems.join(" ")).toContain("output");
    expect(problems.join(" ")).toContain("deepseek/deepseek-v4.1-flash");
  });

  it("checks the SHIPPED table against the SHIPPED record when no record is passed", () => {
    // The refresh script relies on this default: omitting the record must mean the committed one,
    // not an empty one that would report no problems for anything.
    expect(ceilingsBelowObserved(modelPriceTable)).toEqual([]);
    expect(ceilingsBelowObserved({})).not.toEqual([]);
  });

  it("flags a recorded model that has no price at all, rather than skipping it", () => {
    const record = {
      verifiedAt: "2026-01-01",
      source: "s",
      observedDearest: { "nobody/nothing": { inputUsdPer1k: 1, outputUsdPer1k: 1, providers: 1 } },
    };
    const problems = ceilingsBelowObserved({}, record);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no price in modelPriceTable");
  });

  it("exposes the committed record and its constants consistently", () => {
    expect(priceFloorRecord.verifiedAt).toBe(PRICE_FLOOR_VERIFIED_AT);
    expect(priceFloorRecord.observedDearest).toBe(observedDearest);
  });

  it("reproduces the committed data module byte for byte, ignoring line endings", () => {
    // The generated file and the renderer must agree, or the observation the guard checks is not the
    // observation the refresh script would write. Newlines are normalised because git converts them
    // on checkout and CI is not this machine.
    const onDisk = readFileSync(
      resolve(process.cwd(), PRICE_FLOOR_DATA_RELATIVE_PATH),
      "utf8",
    );
    const normalize = (text: string) => text.replace(/\r\n/g, "\n");
    expect(normalize(renderPriceFloorModule(priceFloorRecord))).toBe(normalize(onDisk));
  });
});

describe("#498 staleness is surfaced, not hidden", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("stays quiet while the observation is inside its TTL", () => {
    expect(stalenessNotice(verifiedAt)).toBeNull();
    const justInside = new Date(verifiedAt.getTime() + PRICE_FLOOR_TTL_DAYS * DAY);
    expect(stalenessNotice(justInside)).toBeNull();
  });

  it("names the verification date, the age and the refresh command once past the TTL", () => {
    const past = new Date(verifiedAt.getTime() + (PRICE_FLOOR_TTL_DAYS + 3) * DAY);
    const notice = stalenessNotice(past);
    expect(notice).toBeTruthy();
    expect(notice).toContain(PRICE_FLOOR_VERIFIED_AT);
    expect(notice).toContain(String(PRICE_FLOOR_TTL_DAYS));
    expect(notice).toContain("prices:check");
    expect(notice).toMatch(/STALE/i);
  });

  it("measures the record it is given, not always the committed one", () => {
    const old = {
      verifiedAt: "2020-01-01",
      source: "s",
      observedDearest: { "a/b": { inputUsdPer1k: 1, outputUsdPer1k: 2, providers: 1 } },
    };
    expect(stalenessNotice(new Date("2026-01-01T00:00:00Z"), old)).toBeTruthy();
    expect(stalenessNotice(new Date("2020-01-01T00:00:00Z"), old)).toBeNull();
  });
});

describe("#499 - the adopted rate is not set by one outlier provider", () => {
  // The live reading for the default model on 2026-10-29 (41 providers), and the reading that started this
  // issue on 2026-10-27. Both are asserted: the rule must be inert on the first and binding on the second.
  const spread = (dearest: number, second: number): number[] => [
    ...Array<number>(2).fill(0.0006),
    ...Array<number>(20).fill(0.00084),
    ...Array<number>(16).fill(0.0012),
    ...Array<number>(2).fill(second),
    dearest,
  ];
  // 41 providers, reproducing the measured statistics exactly: median 0.00084, p90 0.0012, second-dearest
  // 0.0018, dearest 0.0024. A stand-in with fewer values would not have the p90 the rule turns on.
  const TODAY_OUTPUTS = spread(0.0024, 0.0018);
  const OCT27_OUTPUTS = spread(0.015863057, 0.0024);

  it("describes the provider distribution instead of keeping only the maximum", () => {
    const d = distributionOf(TODAY_OUTPUTS)!;

    expect(d.providers).toBe(TODAY_OUTPUTS.length);
    expect(d.median).toBeCloseTo(0.00084, 9);
    expect(d.secondDearest).toBeCloseTo(0.0018, 9);
    expect(d.p90).toBeGreaterThanOrEqual(d.median);
  });

  it("has nothing to say about a single provider", () => {
    expect(distributionOf([0.0024])).toBeNull();
    expect(capRate([0.0024]).adoptedUsdPer1k).toBe(0.0024);
  });

  it("is INERT against today's real reading: no outlier, so the dearest is adopted", () => {
    const capped = capRate(TODAY_OUTPUTS);

    expect(capped.adoptedUsdPer1k).toBeCloseTo(0.0024, 9);
    expect(capped.cappedFromUsdPer1k).toBeUndefined();
  });

  it("BINDS against the 2026-10-27 reading: the outlier does not set the reservation", () => {
    const capped = capRate(OCT27_OUTPUTS);
    const p90 = distributionOf(OCT27_OUTPUTS)!.p90;

    expect(capped.adoptedUsdPer1k).toBeCloseTo(PRICE_OUTLIER_MULTIPLE * p90, 9);
    expect(capped.adoptedUsdPer1k).toBeLessThan(0.015863057);
    // Nothing is hidden: what was declined is reported.
    expect(capped.cappedFromUsdPer1k).toBeCloseTo(0.015863057, 9);
  });

  it("still raises the adopted rate on a broad move, because the bound tracks the peers", () => {
    const doubled = TODAY_OUTPUTS.map((v) => v * 2);

    expect(capRate(doubled).adoptedUsdPer1k).toBeCloseTo(
      2 * capRate(TODAY_OUTPUTS).adoptedUsdPer1k,
      9,
    );
  });
});
