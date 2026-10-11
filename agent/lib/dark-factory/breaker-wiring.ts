/**
 * Dark Factory — circuit-breaker wiring for the coding loop (#312).
 *
 * `circuit-breaker.ts` is a complete guard that, until now, nothing ever constructed: no
 * worker activity was recorded in production, so no trip could occur. This module owns the
 * two things the coding loop deliberately does not know about:
 *
 * 1. THE KEY. The budget is charged to the ISSUE, not the run. A `runId`
 *    (`owner/repo#312`) contains `/` and `#`, which `PBI_ID_PATTERN` rejects, and a per-run
 *    key would reset the budget on every retry — defeating the point of a cumulative cap.
 * 2. THE BINDING of a breaker into the loop's narrow seam.
 *
 * The breaker is a GUARD, not telemetry: once a PBI's budget is exceeded the coding loop
 * halts fail-closed at its next cooperative boundary rather than continuing to spend.
 */

import {
  createWorkerActivityObserver,
  type CircuitBreaker,
} from "./circuit-breaker";
import type { CodingLoopBreaker } from "./developer-agent";

/** Prefix applied to a PBI id derived from an issue number (e.g. `pbi-312`). */
export const PBI_ID_PREFIX = "pbi-";

/**
 * Derive the breaker's PBI key from an issue number.
 *
 * Fail-closed: an issue number that cannot form a valid id throws rather than producing a
 * key the breaker would reject later (or, worse, a key that silently keys on nothing).
 */
export function pbiIdForIssue(issue: number): string {
  if (!Number.isSafeInteger(issue) || issue <= 0) {
    throw new Error(
      `Cannot derive a circuit-breaker PBI id from issue number ${String(issue)}: expected a positive integer.`,
    );
  }
  return `${PBI_ID_PREFIX}${issue}`;
}

/**
 * Bind a breaker to one issue so the coding loop can consume it.
 *
 * One PBI key, one guard: every iteration of every run for this issue is charged to the
 * same budget, which is what makes the cap meaningful across retries.
 */
export function createCodingLoopBreaker(
  breaker: CircuitBreaker,
  issue: number,
): CodingLoopBreaker {
  return {
    pbiId: pbiIdForIssue(issue),
    isTripped: (pbiId: string) => breaker.isTripped(pbiId),
    recordActivity: createWorkerActivityObserver(breaker),
  };
}
