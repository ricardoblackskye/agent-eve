import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison for secrets (e.g. bearer tokens).
 *
 * A plain `===` leaks the secret through response-time differences, because the
 * comparison short-circuits on the first differing byte. `timingSafeEqual` does
 * not, but it throws on unequal buffer lengths - so we reject a length mismatch
 * first. `null`/`undefined` inputs are treated as empty strings.
 */
export function constantTimeEqual(a: string | null, b: string | null): boolean {
  const bufA = Buffer.from(a ?? "");
  const bufB = Buffer.from(b ?? "");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
