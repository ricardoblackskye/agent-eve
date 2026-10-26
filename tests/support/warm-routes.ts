/**
 * Warm dev-mode routes before an E2E assertion runs (#473).
 *
 * `next dev` compiles a route on first touch. On a cold tree that is 25-37s, which is longer
 * than the specs' 15s expect timeout, so four specs reported failures that looked like product
 * regressions but were only a compiler. The fix is to pay that cost in setup, never inside a
 * timed assertion, and never by widening the assertion budget.
 *
 * The rules live here, behind an injected request function, so they are unit-testable: the same
 * reasoning as #376, where a defect survived precisely because it lived inside an untestable
 * entry point.
 *
 * Two rules carry all the weight:
 *
 * - A status BELOW 500 counts as warmed, including 404. The unknown-run-id route is *supposed*
 *   to 404 and still proves the route compiled. Treating it as a failure would make the
 *   warm-up report a lie.
 * - A 5xx does NOT count, and a target that never succeeds must THROW rather than give up
 *   quietly. A silent give-up leaves the original race in place while looking fixed.
 */

/** How many times one target is attempted before the warm-up gives up and throws. */
export const DEFAULT_WARM_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 250;

/** Returns the HTTP status for a path. Rejects on a transport-level failure. */
export type WarmRequest = (path: string) => Promise<number>;

export interface WarmOptions {
  /** Attempts per target, including the first. Must be a positive integer. */
  attempts?: number;
  /** Wait between failed attempts. Not applied after the final one. */
  retryDelayMs?: number;
  /** Injectable so tests do not spend real time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface WarmedRoute {
  path: string;
  /** The status that ended the wait: below 500 means the route compiled. */
  status: number;
  /** How many attempts the final status took. */
  attempts: number;
}

export interface WarmReport {
  warmed: WarmedRoute[];
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Request each target until it answers with a status below 500.
 *
 * Targets are de-duplicated so a route is compiled once even when two callers ask for it.
 * Throws, naming the route, if any target never answers below 500 — a warm-up that silently
 * gives up would leave the race it was meant to remove.
 */
export async function warmRoutes(
  targets: string[],
  request: WarmRequest,
  options: WarmOptions = {},
): Promise<WarmReport> {
  const attempts = options.attempts ?? DEFAULT_WARM_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = options.sleep ?? realSleep;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error(
      `warm-up attempts must be a positive integer, received ${attempts}`,
    );
  }

  const warmed: WarmedRoute[] = [];
  const seen = new Set<string>();

  for (const path of targets) {
    if (seen.has(path)) continue;
    seen.add(path);

    let succeeded = false;
    let used = 0;
    let lastStatus: number | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      used = attempt;
      try {
        const status = await request(path);
        lastStatus = status;
        lastError = undefined;

        if (status < 500) {
          warmed.push({ path, status, attempts: attempt });
          succeeded = true;
          break;
        }
      } catch (error) {
        // A transport failure is a reason to retry, not a reason to give up: a connection
        // refused while the dev server is still coming up is exactly the cold-start case.
        lastStatus = undefined;
        lastError = error;
      }

      if (attempt < attempts) await sleep(retryDelayMs);
    }

    if (!succeeded) {
      const detail =
        lastStatus !== undefined
          ? `last status ${lastStatus}`
          : `last error: ${describeError(lastError)}`;
      throw new Error(
        `warm-up failed for ${path} after ${used} attempt(s): ${detail}`,
      );
    }
  }

  return { warmed };
}
