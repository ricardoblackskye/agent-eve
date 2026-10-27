/**
 * The price receipt (#494 follow-up).
 *
 * The price ceiling is guarded by TWO mechanisms, and this file is the hermetic half.
 *
 * A live price assertion inside the default unit suite is a unit test against a value
 * somebody else changes. The ceiling test went red on `main` three times in one day
 * because the dearest provider rate for the default model moved 0.004177242 ->
 * 0.005559908 -> 0.006115898, and every one of those reds blocked a PR that had nothing
 * to do with pricing. That is not a flaky test; it is a test asserting the wrong thing.
 *
 * So the price guard is split the way ADR 0067 split the model-availability guard:
 *
 *   - a committed RECEIPT records the dearest provider rate that was actually seen,
 *     with the date and the endpoint it came from;
 *   - the unit suite asserts, hermetically, that the shipped ceiling still covers the
 *     receipt. It touches no network, and it can only go red when WE change a ceiling;
 *   - `npm run prices:check` performs the live comparison and is what the scheduled
 *     drift workflow runs. Drift opens an issue; it does not block a merge.
 *
 * The receipt is what was SEEN, not a mirror of the catalog, for the same reason as its
 * model-availability sibling: a snapshot regenerated from whatever the provider returns
 * is a rubber stamp that stops checking anything while still going green.
 */

/** Dearest provider rate observed for one model, in USD per 1k tokens. */
export interface PriceObservation {
  inputUsdPer1k: number;
  outputUsdPer1k: number;
  /** How many providers were priced at the time. Kept so a thin result is visible. */
  providers: number;
}

/** A committed record of what was actually observed upstream. */
export interface PriceReceipt {
  /** ISO date (YYYY-MM-DD) the catalog was read. */
  verifiedAt: string;
  /** The endpoint the observation came from. */
  source: string;
  /** Keyed by model id. A declared model with no entry is unverified. */
  observedDearest: Record<string, PriceObservation>;
}

export type ParseResult =
  | { kind: "ok"; receipt: PriceReceipt }
  | { kind: "malformed"; reason: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Parse defensively: a malformed receipt is reported, never thrown. */
export function parsePriceReceipt(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "malformed", reason: "not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { kind: "malformed", reason: "not an object" };
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.verifiedAt !== "string") {
    return { kind: "malformed", reason: "verifiedAt is not a string" };
  }
  if (!ISO_DATE.test(candidate.verifiedAt)) {
    return { kind: "malformed", reason: "verifiedAt is not an ISO date" };
  }
  if (typeof candidate.source !== "string" || candidate.source === "") {
    return { kind: "malformed", reason: "source is not a non-empty string" };
  }
  const observed = candidate.observedDearest;
  if (typeof observed !== "object" || observed === null || Array.isArray(observed)) {
    return { kind: "malformed", reason: "observedDearest is not an object" };
  }
  for (const [id, value] of Object.entries(observed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      return { kind: "malformed", reason: `${id} is not an object` };
    }
    const entry = value as Record<string, unknown>;
    if (!isFiniteNumber(entry.inputUsdPer1k)) {
      return { kind: "malformed", reason: `${id} inputUsdPer1k is not a number` };
    }
    if (!isFiniteNumber(entry.outputUsdPer1k)) {
      return { kind: "malformed", reason: `${id} outputUsdPer1k is not a number` };
    }
    if (!isFiniteNumber(entry.providers)) {
      return { kind: "malformed", reason: `${id} providers is not a number` };
    }
  }
  return { kind: "ok", receipt: raw as PriceReceipt };
}

export function buildPriceReceipt(
  observed: Record<string, PriceObservation>,
  source: string,
  now: Date,
): PriceReceipt {
  return {
    verifiedAt: now.toISOString().slice(0, 10),
    source,
    observedDearest: observed,
  };
}

/** Declared models with no receipt entry. A missing entry fails rather than skips. */
export function unverifiedPriceModels(
  declared: readonly string[],
  receipt: PriceReceipt,
): string[] {
  return declared.filter((id) => !(id in receipt.observedDearest));
}

/**
 * Shipped ceilings that no longer cover the dearest rate seen.
 *
 * Returns human-readable descriptions so a failure names the axis and the numbers.
 */
export function ceilingsBelowObserved(
  table: Record<string, { inputUsdPer1k: number; outputUsdPer1k: number }>,
  receipt: PriceReceipt,
): string[] {
  const problems: string[] = [];
  for (const [id, observed] of Object.entries(receipt.observedDearest)) {
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
