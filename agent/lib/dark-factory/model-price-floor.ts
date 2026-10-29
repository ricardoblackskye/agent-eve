/**
 * Dark Factory - the reservation price FLOOR (#498).
 *
 * `admit()` reserves against `modelPriceTable` before a call and only trues up at `settle()`, so the
 * reserved number must be an upper bound (ADR 0027). The table is a hand-maintained constant, and
 * that is exactly what failed: the entry for the default model sat at 0.0024 while the dearest
 * provider rate climbed to 0.015863057 within a single day, so every reservation understated the call and the breach only
 * appeared after the money was spent.
 *
 * This module records the dearest rate we have actually VERIFIED per model, and `resolvePrice` returns
 * the higher of the table entry and this floor. The floor can only ever raise the reserved number, so
 * it is inert while the table carries headroom and protective the moment the table falls behind.
 *
 * The observation lives in `model-price-floor-data.ts` beside this file, and that file is the ONE home
 * for it. It is shipped, not test-side, because the reservation path runs in `agent/`. The refresh
 * script writes exactly the path this module reads - `PRICE_FLOOR_DATA_RELATIVE_PATH` exists so the
 * writer and the reader cannot drift apart - and the unit suite reads the same data through this
 * module rather than keeping a second copy. A second copy is how a guard ends up checking an
 * observation nobody reserved against.
 *
 * Two things this deliberately is NOT:
 *
 *   - It is not a mirror of the provider catalog. It records what was SEEN, dated. A value regenerated
 *     from whatever the provider currently returns is a rubber stamp: it would make the guard pass
 *     without anyone deciding anything.
 *   - It is not a guarantee against a rise occurring after the verification date. The floor is only as
 *     fresh as `PRICE_FLOOR_VERIFIED_AT`, and that window is bounded by the scheduled drift workflow,
 *     not by this code. ADR 0071 states the bound rather than implying a guarantee we cannot make.
 *
 * The env override `DF_MODEL_PRICE_<stableId>` still wins over this floor: ADR 0027 documents it as
 * the escape hatch for an operator who knows the provider in use, and pinning a cheaper provider is a
 * legitimate reason to set it. The floor guards the shared table, not an explicit per-deployment act.
 */

import { priceFloorRecord } from "./model-price-floor-data";

/** The dearest published provider rate observed for one model, in USD per 1k tokens. */
export interface DearestObservation {
  inputUsdPer1k: number;
  outputUsdPer1k: number;
  /** Providers priced at the time, so a thin or partial read is visible rather than silent. */
  providers: number;
  /**
   * How the providers were distributed, per axis (#499). Recorded, not just printed: a drift issue has to be
   * able to show the distribution of the reading that was adopted, and an outlier has to be visible at the
   * moment it appears rather than reconstructed later.
   */
  distribution?: { input: RateDistribution; output: RateDistribution };
  /**
   * The raw dearest per axis, present ONLY when it was declined for being an outlier. Absence means the dearest
   * was adopted as-is, which is the normal case.
   */
  declinedDearestUsdPer1k?: { input?: number; output?: number };
}

/** A committed record of what was actually observed upstream. */
export interface PriceFloorRecord {
  /** ISO date (YYYY-MM-DD) the catalog was read. */
  verifiedAt: string;
  /** The endpoint the observation came from. */
  source: string;
  /** Keyed by model id. A declared model with no entry is unverified. */
  observedDearest: Record<string, DearestObservation>;
}

/**
 * The data file, relative to the repo root. The refresh script writes this exact path, so the writer
 * and the reader cannot disagree about where the observation lives.
 */
export const PRICE_FLOOR_DATA_RELATIVE_PATH =
  "agent/lib/dark-factory/model-price-floor-data.ts";

/** Re-exported so callers and tests have one import site for the committed observation. */
export { priceFloorRecord };

/** ISO date the catalog was read. Staleness is measured from here, never from process start. */
export const PRICE_FLOOR_VERIFIED_AT: string = priceFloorRecord.verifiedAt;

/** The endpoint the observation came from. */
export const PRICE_FLOOR_SOURCE: string = priceFloorRecord.source;

/** How long a verification is trusted before it is surfaced as stale. */
export const PRICE_FLOOR_TTL_DAYS = 90;

/** The dearest rate seen per model id. Observation record, not a catalog mirror. */
export const observedDearest: Record<string, DearestObservation> =
  priceFloorRecord.observedDearest;

/**
 * The multiple of p90 above which a provider is an OUTLIER rather than the market (#499).
 *
 * Derived, not chosen for convenience. Measured on 2026-10-29, p90 for the default model was 0.0012, so the cap
 * is 0.0036: inert against that day's dearest (0.0024) and binding against the 0.015863057 the observation
 * recorded on 2026-10-27. A multiple that binds when no outlier exists is a different defect with the same
 * symptom, which is why both readings are asserted.
 */
export const PRICE_OUTLIER_MULTIPLE = 3;

/** How the provider rates behind one axis were distributed, so an outlier is visible when it is seen. */
export interface RateDistribution {
  median: number;
  p90: number;
  secondDearest: number;
  providers: number;
}

/** What the refresh path may adopt for one axis, and what it declined to adopt. */
export interface CappedRate {
  adoptedUsdPer1k: number;
  /** The raw dearest, present only when it exceeded the cap. */
  cappedFromUsdPer1k?: number;
  distribution: RateDistribution | null;
}

/**
 * Summarise the provider rates for one axis (#499, acceptance criterion 4).
 *
 * The refresh path already fetches every provider rate and then keeps only the maximum, which is why an outlier
 * could set the reservation without anyone seeing the distribution that made it one. Returns `null` when there is
 * not enough spread to describe (a single provider has no peers to be an outlier against).
 *
 */
export function distributionOf(values: readonly number[]): RateDistribution | null {
  const rates = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (rates.length < 2) return null;
  return {
    median: nearestRank(rates, 0.5),
    p90: nearestRank(rates, 0.9),
    secondDearest: rates[rates.length - 2] as number,
    providers: rates.length,
  };
}

/** Nearest-rank percentile over an ascending list, the convention the repository's benchmarks use. */
function nearestRank(sorted: readonly number[], quantile: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(quantile * sorted.length) - 1),
  );
  return sorted[index] as number;
}

/**
 * The rate the refresh path may adopt for one axis (#499).
 *
 * Inert when no provider is far from its peers; binds, and reports what it declined, when one is.
 *
 */
export function capRate(values: readonly number[]): CappedRate {
  const rates = values.filter((v) => Number.isFinite(v));
  if (rates.length === 0) return { adoptedUsdPer1k: 0, distribution: null };

  const dearest = Math.max(...rates);
  const distribution = distributionOf(rates);
  // One provider has no peers to be an outlier against, so nothing can be declined.
  if (!distribution) return { adoptedUsdPer1k: dearest, distribution: null };

  const cap = PRICE_OUTLIER_MULTIPLE * distribution.p90;
  if (dearest > cap) {
    // Reported, never hidden: the caller prints this, and the record can carry what was declined.
    return { adoptedUsdPer1k: cap, cappedFromUsdPer1k: dearest, distribution };
  }
  return { adoptedUsdPer1k: dearest, distribution };
}

/**
 * The floor for a model, normalised the same way `resolvePrice` normalises. Unknown returns
 * `undefined` - callers must not invent a floor.
 */
export function floorFor(
  model: string | null | undefined,
): DearestObservation | undefined {
  if (typeof model !== "string" || model.trim() === "") return undefined;
  const normalized = model.trim().toLowerCase();
  const observed = observedDearest[normalized];
  if (!observed) return undefined;
  // Deep copy, matching resolvePrice: callers must never mutate the canonical record.
  return { ...observed };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Midnight UTC on the verification date. Parsed on every call rather than captured at module load,
 * so a mis-typed date fails loudly instead of silently ageing from an epoch.
 */
function ageDaysFrom(verifiedAt: string, now: Date): number {
  const parsed = Date.parse(`${verifiedAt}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    throw new Error(`price floor verifiedAt is not an ISO date: ${verifiedAt}`);
  }
  return Math.floor((now.getTime() - parsed) / DAY_MS);
}

/** Whole days between the verification date and `now`. */
export function floorAgeDays(
  now: Date,
  record: PriceFloorRecord = priceFloorRecord,
): number {
  return ageDaysFrom(record.verifiedAt, now);
}

/** True once the verification is older than `PRICE_FLOOR_TTL_DAYS`. */
export function isFloorStale(
  now: Date,
  record: PriceFloorRecord = priceFloorRecord,
): boolean {
  return floorAgeDays(now, record) > PRICE_FLOOR_TTL_DAYS;
}

/**
 * Build a record from a fresh reading. Used by the refresh script; kept here so the writer and the
 * reader share ONE definition of the shape.
 */
export function buildPriceFloorRecord(
  observed: Record<string, DearestObservation>,
  source: string,
  now: Date,
): PriceFloorRecord {
  return {
    verifiedAt: now.toISOString().slice(0, 10),
    source,
    observedDearest: observed,
  };
}

/**
 * Render the GENERATED data module for a record.
 *
 * This lives here, beside the shape it writes, so the file the refresh script emits and the shape
 * this module reads cannot drift apart. `tests/dark-factory/model-price-floor.test.ts` asserts that
 * rendering the committed record reproduces the committed file byte for byte - so a hand-edit to the
 * generated file, or a formatting change in this renderer, fails the build instead of surfacing later
 * as an observation nobody reserved against.
 */
export function renderPriceFloorModule(record: PriceFloorRecord): string {
  const header = [
    "/**",
    " * GENERATED FILE - do not edit by hand.",
    " *",
    " * The observed-dearest price record consumed by `model-price-floor.ts`. Two reasons it is a TS",
    " * module rather than a JSON file:",
    " *",
    " *   1. `agent/` only accepts supported authored modules - the Eve build rejects a bare `.json`",
    " *      inside `agent/lib/` (\"Expected ... to be a supported authored module within lib/\").",
    " *   2. Being generated wholesale means the refresh script owns every line of it, so there is no",
    " *      hand-written region to parse and no chance of the writer and the reader disagreeing.",
    " *",
    " * Refresh with:  npm run prices:check -- --write",
    " *",
    " * It records what was SEEN, dated. It is not a mirror of the provider catalog, and it is not a",
    " * substitute for re-verifying: see ADR 0071.",
    " */",
    "",
    'import type { PriceFloorRecord } from "./model-price-floor";',
    "",
  ].join("\n");

  const entries = Object.keys(record.observedDearest)
    .sort()
    .map((id) => {
      const observed = record.observedDearest[id];
      const figure = (v: number): number => Number(v.toPrecision(12));
      const axis = (d: RateDistribution): string =>
        `{ median: ${figure(d.median)}, p90: ${figure(d.p90)}, secondDearest: ${figure(d.secondDearest)}, ` +
        `providers: ${d.providers} }`;
      const distribution = observed.distribution
        ? `      distribution: { input: ${axis(observed.distribution.input)}, output: ${axis(observed.distribution.output)} },\n`
        : "";
      const declined = observed.declinedDearestUsdPer1k
        ? `      declinedDearestUsdPer1k: ${JSON.stringify(observed.declinedDearestUsdPer1k, (_k, v) =>
            typeof v === "number" ? figure(v) : v,
          )},\n`
        : "";
      return (
        `    ${JSON.stringify(id)}: {\n` +
        `      inputUsdPer1k: ${observed.inputUsdPer1k},\n` +
        `      outputUsdPer1k: ${observed.outputUsdPer1k},\n` +
        `      providers: ${observed.providers},\n` +
        distribution +
        declined +
        "    },"
      );
    })
    .join("\n");

  const body = [
    "export const priceFloorRecord: PriceFloorRecord = {",
    `  verifiedAt: ${JSON.stringify(record.verifiedAt)},`,
    `  source: ${JSON.stringify(record.source)},`,
    "  observedDearest: {",
    entries,
    "  },",
    "};",
    "",
  ].join("\n");

  return `${header}export ${body.slice("export ".length)}`;
}

/**
 * A one-line notice when the committed observation is past its TTL, else `null`.
 *
 * The refresh script prints it, so staleness is visible on the scheduled run rather than only in a
 * test. Warning rather than fatal, following ADR 0067 - a fail-closed floor would turn a housekeeping
 * lapse into an outage. ADR 0071 records that choice and the stricter alternative.
 */
export function stalenessNotice(
  now: Date,
  record: PriceFloorRecord = priceFloorRecord,
): string | null {
  const age = floorAgeDays(now, record);
  if (age <= PRICE_FLOOR_TTL_DAYS) return null;
  return (
    `STALE: the price observation was last verified on ${record.verifiedAt} ` +
    `(${age} days ago; TTL ${PRICE_FLOOR_TTL_DAYS} days). ` +
    "Re-verify with: npm run prices:check -- --write"
  );
}

/** Declared models with no recorded observation. A missing entry fails rather than skips. */
export function unverifiedPriceModels(
  declared: readonly string[],
  record: PriceFloorRecord = priceFloorRecord,
): string[] {
  return declared.filter((id) => !(id in record.observedDearest));
}

/**
 * Shipped ceilings that no longer cover the dearest rate seen.
 *
 * Returns human-readable descriptions so a failure names the axis and both numbers.
 */
export function ceilingsBelowObserved(
  table: Record<string, { inputUsdPer1k: number; outputUsdPer1k: number }>,
  record: PriceFloorRecord = priceFloorRecord,
): string[] {
  const problems: string[] = [];
  for (const [id, observed] of Object.entries(record.observedDearest)) {
    const price = table[id];
    if (!price) {
      problems.push(`${id}: no price in modelPriceTable (an unpriced model refuses calls)`);
      continue;
    }
    if (price.inputUsdPer1k < observed.inputUsdPer1k) {
      problems.push(
        `${id} input: ceiling ${price.inputUsdPer1k} is below the dearest observed ${observed.inputUsdPer1k}`,
      );
    }
    if (price.outputUsdPer1k < observed.outputUsdPer1k) {
      problems.push(
        `${id} output: ceiling ${price.outputUsdPer1k} is below the dearest observed ${observed.outputUsdPer1k}`,
      );
    }
  }
  return problems;
}
