/**
 * Dark Factory - the reservation price FLOOR (#498).
 *
 * `admit()` reserves against `modelPriceTable` before a call and only trues up at `settle()`, so the
 * reserved number must be an upper bound (ADR 0027). The table is a hand-maintained constant, and
 * that is exactly what failed: the entry for the default model sat at 0.0024 while the dearest
 * provider rate climbed to 0.006727487, so every reservation understated the call and the breach only
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
function verifiedAtMs(): number {
  const parsed = Date.parse(`${PRICE_FLOOR_VERIFIED_AT}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `PRICE_FLOOR_VERIFIED_AT is not an ISO date: ${PRICE_FLOOR_VERIFIED_AT}`,
    );
  }
  return parsed;
}

/** Whole days between the verification date and `now`. */
export function floorAgeDays(now: Date): number {
  return Math.floor((now.getTime() - verifiedAtMs()) / DAY_MS);
}

/** True once the verification is older than `PRICE_FLOOR_TTL_DAYS`. */
export function isFloorStale(now: Date): boolean {
  return floorAgeDays(now) > PRICE_FLOOR_TTL_DAYS;
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
      return (
        `    ${JSON.stringify(id)}: {\n` +
        `      inputUsdPer1k: ${observed.inputUsdPer1k},\n` +
        `      outputUsdPer1k: ${observed.outputUsdPer1k},\n` +
        `      providers: ${observed.providers},\n` +
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
  throw new Error("not implemented");
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
