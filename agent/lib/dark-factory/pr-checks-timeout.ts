/**
 * How long the Definition of Done waits for the pull request's checks (#676).
 *
 * The wait POLLS and returns the moment nothing is unsettled, so this number is not a latency
 * budget - it is a CEILING, reached only by a check that never settles. That is why a generous
 * default costs a fast repository nothing: `pr-check-gate.test.ts` pins the early return
 * ("returns the checks as soon as they have all finished, with one read").
 *
 * The default is forty-five minutes because #659 gates the WHOLE PROJECT: every check is blocking, so
 * one deadline must cover the pull request's queue plus its slowest descriptor. It was raised from
 * twenty on 2026-11-26 (#722), where the twenty-minute premise - that `e2e` and `MegaLinter` are each
 * "around ten minutes" on WebFeedPOC - was superseded by measurement: `e2e` took 22 min 8 s on run
 * `c2f3ff82` (WebFeedPOC#266, its other five checks long since green) and around thirty minutes across
 * four earlier runs, so a wholly healthy pull request was denied `done` by the ceiling alone.
 *
 * RE-MEASURE THIS whenever a target's checks change shape. The number is a measurement, not a
 * preference, and it was left at a superseded measurement once already.
 *
 * A launcher that sets `DF_PR_CHECKS_TIMEOUT_MS` to a value SMALLER than this default is working
 * against the sizing decision: six launchers pinned `600000` (ten minutes) and deferred runs whose
 * checks this default already covered. Pin the override only to be MORE patient, never less.
 *
 * A malformed override must never make things worse. `Number("5m")` is NaN, and in the settle loop
 * the comparison `now - started >= NaN` is false forever - so a typo would convert this bounded wait
 * into an unbounded one. Anything that does not parse as a positive, finite number falls back.
 */
export const DEFAULT_PR_CHECKS_TIMEOUT_MS = 45 * 60_000;

/**
 * The bound for the DoD's wait on the pull request's checks, in milliseconds.
 *
 * The parameter is optional and read by KEY rather than taken as `ProcessEnv`: this project augments
 * `ProcessEnv` with a required `NODE_ENV` and no index signature, so passing it (or defaulting to it)
 * trips TypeScript's weak-type check. Omitting the argument reads the live environment, which is what
 * the runner does; a test passes the one key it cares about.
 */
export function resolvePrChecksTimeoutMs(
  env?: Record<string, string | undefined>,
): number {
  const raw = env ? env.DF_PR_CHECKS_TIMEOUT_MS : process.env.DF_PR_CHECKS_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PR_CHECKS_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PR_CHECKS_TIMEOUT_MS;
  return parsed;
}
