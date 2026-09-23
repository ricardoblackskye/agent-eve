/**
 * Pure retry policy for the PR reviewer's model calls (#191).
 *
 * The reviewer talks to OpenRouter, which load-balances across providers and
 * can return a transient HTTP 429 ("temporarily rate-limited upstream",
 * `limit_source: upstream_provider_shared_pool`) or a 5xx. The script used to
 * fall straight through to the structural fallback on any such hiccup, so the
 * job had to be re-run by hand. This module decides *whether* a failure is
 * worth retrying and *how long* to wait, so the script can retry transient
 * failures without masking genuine configuration errors.
 *
 * Kept pure (no I/O, no globals beyond an injectable `random`/`now`) so it is
 * unit-testable; `scripts/pr-reviewer.ts` owns the actual fetch loop.
 */
export const RETRY_DEFAULTS = {
  /** Base backoff; doubles per attempt. */
  baseMs: 2000,
  /** Upper bound on any single wait, including a server `Retry-After`. */
  capMs: 15000,
  /** Total attempts (initial call + retries). */
  maxAttempts: 3,
} as const;

export interface ModelFailure {
  /** HTTP status, or null/undefined for a network/transport error. */
  status?: number | null;
  /** True for an HTTP 200 that carried no usable content. */
  emptyContent?: boolean;
}

/**
 * Decide whether a model-call failure is transient (retryable).
 *
 * Transient: 429, any 5xx, a network/transport error (no status), or an empty
 * 200. NOT transient: 400/401/403/404 — a bad key or malformed request must
 * surface immediately, not loop.
 */
export function isTransientModelError(failure: ModelFailure): boolean {
  const status = failure.status;
  if (typeof status !== "number") {
    // No HTTP status at all → a network/transport error.
    return true;
  }
  if (status === 429 || status >= 500) return true;
  if (status >= 400) return false; // 400/401/403/404 … config errors
  if (status === 200) return Boolean(failure.emptyContent);
  return false;
}

/**
 * Parse a `Retry-After` value (integer seconds or an HTTP-date) into ms.
 * Returns null when absent or unparseable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Integer seconds (the common HTTP form), including "0". A negative value
  // is invalid — reject it rather than letting Date.parse coerce it.
  if (/^-?\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds < 0 ? null : seconds * 1000;
  }

  // HTTP-date form.
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - nowMs);
}

/**
 * Delay before retry `attempt` (1-based): exponential from `baseMs`, plus up
 * to one base of jitter, capped at `capMs`. An explicit `retryAfterMs` (from a
 * server hint) wins, still capped. Never negative.
 */
export function retryDelayMs(
  attempt: number,
  opts: {
    retryAfterMs?: number | null;
    baseMs?: number;
    capMs?: number;
    random?: () => number;
  } = {},
): number {
  const baseMs = opts.baseMs ?? RETRY_DEFAULTS.baseMs;
  const capMs = opts.capMs ?? RETRY_DEFAULTS.capMs;
  const random = opts.random ?? Math.random;

  const serverHint = opts.retryAfterMs;
  if (typeof serverHint === "number" && Number.isFinite(serverHint)) {
    return Math.max(0, Math.min(serverHint, capMs));
  }

  const n = Math.max(1, Math.floor(attempt));
  const exponential = baseMs * Math.pow(2, n - 1);
  const jitter = random() * baseMs;
  return Math.max(0, Math.min(exponential + jitter, capMs));
}
