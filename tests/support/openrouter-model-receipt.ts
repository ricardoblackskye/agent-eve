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
 * TDD RED stub: types and the minimal signatures only. No behaviour yet.
 */

/** After this many days the receipt is reported as stale — a warning, not a failure. */
export const RECEIPT_TTL_DAYS = 90;

export interface ModelReceipt {
  /** ISO calendar date (YYYY-MM-DD) of the verification run. */
  verifiedAt: string;
  /** The endpoint that was read. */
  source: string;
  /** The ids confirmed present on that date. */
  models: string[];
}

export type ReceiptParse =
  | { kind: "ok"; receipt: ModelReceipt }
  | { kind: "malformed"; reason: string };

export function parseReceipt(_raw: string): ReceiptParse {
  throw new Error("not implemented");
}

/** Declared ids with no entry in the receipt, in the order given. */
export function unverifiedModelIds(
  _receipt: ModelReceipt,
  _declaredIds: string[],
): string[] {
  throw new Error("not implemented");
}

export function receiptAgeDays(_receipt: ModelReceipt, _now: Date): number {
  throw new Error("not implemented");
}

/** A message when the receipt is stale, or null while it is fresh. */
export function stalenessWarning(
  _receipt: ModelReceipt,
  _now: Date,
  _ttlDays?: number,
): string | null {
  throw new Error("not implemented");
}

export function buildReceipt(
  _ids: string[],
  _source: string,
  _now: Date,
): ModelReceipt {
  throw new Error("not implemented");
}
