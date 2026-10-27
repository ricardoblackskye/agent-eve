/**
 * Dark Factory - the reservation price FLOOR (#498).
 *
 * `admit()` reserves against `modelPriceTable` before a call and only trues up at `settle()`, so the
 * reserved number must be an upper bound (ADR 0027). The table is a hand-maintained constant, and
 * that is exactly what failed: the entry for the default model sat at 0.0024 while the dearest
 * provider rate climbed to 0.006727487, so every reservation understated the call and the breach
 * only appeared after the money was spent.
 *
 * This module records the dearest rate we have actually VERIFIED per model, and `resolvePrice`
 * returns the higher of the table entry and this floor. The floor can only ever raise the reserved
 * number, so it is inert while the table carries headroom and protective the moment the table falls
 * behind.
 *
 * Two things this deliberately is NOT:
 *
 *   - It is not a mirror of the provider catalog. It records what was SEEN, with the date. A value
 *     regenerated from whatever the provider currently returns is a rubber stamp: it would make the
 *     guard pass without anyone deciding anything.
 *   - It is not a guarantee against a rise occurring after the verification date. The floor is only
 *     as fresh as `PRICE_FLOOR_VERIFIED_AT`, and that window is bounded by the scheduled drift
 *     workflow, not by this code. The ADR states the bound rather than implying a guarantee the
 *     design cannot make.
 *
 * The env override `DF_MODEL_PRICE_<stableId>` still wins over this floor: ADR 0027 documents it as
 * the escape hatch for an operator who knows the provider in use, and pinning a cheaper provider is
 * a legitimate reason to set it. The floor guards the shared table, not an explicit per-deployment
 * act.
 */

/** The dearest published provider rate observed for one model, in USD per 1k tokens. */
export interface DearestObservation {
  inputUsdPer1k: number;
  outputUsdPer1k: number;
  /** Providers priced at the time, so a thin or partial read is visible rather than silent. */
  providers: number;
}

/** The endpoint the observation came from. */
export const PRICE_FLOOR_SOURCE =
  "https://openrouter.ai/api/v1/models/<id>/endpoints";

/**
 * ISO date the catalog was read. Staleness is measured from here, never from process start.
 */
export const PRICE_FLOOR_VERIFIED_AT = "2026-10-27";

/** How long a verification is trusted before it is surfaced as stale. */
export const PRICE_FLOOR_TTL_DAYS = 90;

/** The dearest rate seen per model id. Observation record, not a catalog mirror. */
export const observedDearest: Record<string, DearestObservation> = {};

/**
 * The floor for a model, normalised the same way `resolvePrice` normalises. Unknown returns
 * `undefined` - callers must not invent a floor.
 */
export function floorFor(
  model: string | null | undefined,
): DearestObservation | undefined {
  throw new Error("not implemented");
}

/** Whole days between the verification date and `now`. */
export function floorAgeDays(now: Date): number {
  throw new Error("not implemented");
}

/** True once the verification is older than `PRICE_FLOOR_TTL_DAYS`. */
export function isFloorStale(now: Date): boolean {
  throw new Error("not implemented");
}
