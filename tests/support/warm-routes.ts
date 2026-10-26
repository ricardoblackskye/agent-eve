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
 *
 * TDD RED stub: types and the minimal signature only. No behaviour yet.
 */

/** How many times one target is attempted before the warm-up gives up and throws. */
export const DEFAULT_WARM_ATTEMPTS = 3;
export const DEFAULT_RETRY_DELAY_MS = 250;

export type WarmRequest = (path: string) => Promise<number>;

export interface WarmOptions {
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WarmedRoute {
  path: string;
  status: number;
  attempts: number;
}

export interface WarmReport {
  warmed: WarmedRoute[];
}

export async function warmRoutes(
  _targets: string[],
  _request: WarmRequest,
  _options: WarmOptions = {},
): Promise<WarmReport> {
  throw new Error("not implemented");
}
