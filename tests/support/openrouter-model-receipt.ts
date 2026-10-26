/**
 * Verification receipt for the model ids this repo declares (#472, part 2).
 *
 * The default suite must be hermetic, but its assertion must still be REAL. So
 * instead of mirroring the provider's whole catalog — which would make every
 * legitimate model swap a red offline test, and pressure whoever hits it into
 * re-recording whatever the provider happens to serve — we commit a RECEIPT:
 * the ids that were confirmed present, and the date they were confirmed.
 *
 *   1. A declared id with no receipt entry  -> FAIL   (nobody verified it)
 *   2. A receipt older than the TTL         -> WARN   (visible, not fatal)
 *
 * A swap therefore cannot pass by editing a file: the new id has no receipt
 * until someone actually asks the provider.
 *
 * A malformed receipt is a loud failure, never a silent pass — the one outcome
 * that would let the guard quietly stop guarding.
 */

/** After this many days the receipt is reported as stale — a warning, not a failure. */
export const RECEIPT_TTL_DAYS = 90;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export interface ModelReceipt {
  /** ISO calendar date (YYYY-MM-DD) of the verification run. */
  verifiedAt: string;
  /** The endpoint that was read. */
  source: string;
  /** The ids confirmed present on that date. */
  models: string[];
}

export type ReceiptParse =
  { kind: "ok"; receipt: ModelReceipt } | { kind: "malformed"; reason: string };

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  return !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime());
}

function utcMidnight(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function parseReceipt(raw: string): ReceiptParse {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { kind: "malformed", reason: "receipt is not valid JSON" };
  }

  if (typeof body !== "object" || body === null) {
    return { kind: "malformed", reason: "receipt is not a JSON object" };
  }

  const { verifiedAt, source, models } = body as Record<string, unknown>;

  if (!isIsoDate(verifiedAt)) {
    return {
      kind: "malformed",
      reason: "verifiedAt is not an ISO date (YYYY-MM-DD)",
    };
  }
  if (typeof source !== "string" || source.length === 0) {
    return { kind: "malformed", reason: "source is missing" };
  }
  if (!Array.isArray(models) || !models.every((id) => typeof id === "string")) {
    return { kind: "malformed", reason: "models must be an array of strings" };
  }

  return { kind: "ok", receipt: { verifiedAt, source, models } };
}

/** Declared ids with no entry in the receipt, in the order given. */
export function unverifiedModelIds(
  receipt: ModelReceipt,
  declaredIds: string[],
): string[] {
  const recorded = new Set(receipt.models);
  return declaredIds.filter((id) => !recorded.has(id));
}

export function receiptAgeDays(receipt: ModelReceipt, now: Date): number {
  const verified = new Date(`${receipt.verifiedAt}T00:00:00Z`).getTime();
  return Math.floor((utcMidnight(now) - verified) / MS_PER_DAY);
}

/** A message when the receipt is stale, or null while it is fresh. */
export function stalenessWarning(
  receipt: ModelReceipt,
  now: Date,
  ttlDays: number = RECEIPT_TTL_DAYS,
): string | null {
  const age = receiptAgeDays(receipt, now);
  if (age <= ttlDays) return null;
  return (
    `the model verification receipt is ${age} days old, older than the ${ttlDays}-day TTL — ` +
    "re-verify with: npm run models:verify"
  );
}

export function buildReceipt(
  ids: string[],
  source: string,
  now: Date,
): ModelReceipt {
  return {
    verifiedAt: now.toISOString().slice(0, 10),
    source,
    models: [...ids],
  };
}
