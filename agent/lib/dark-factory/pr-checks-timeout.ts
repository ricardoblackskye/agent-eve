/**
 * How long the Definition of Done waits for the pull request's checks (#676).
 *
 * The wait POLLS and returns the moment nothing is unsettled, so this number is not a latency
 * budget - it is a CEILING, reached only by a check that never settles. That is why a generous
 * default costs a fast repository nothing: `pr-check-gate.test.ts` pins the early return
 * ("returns the checks as soon as they have all finished, with one read").
 *
 * The default is twenty minutes because #659 gates the WHOLE PROJECT: every check is blocking, so
 * one deadline must cover the pull request's queue plus its slowest descriptor. Observed on
 * WebFeedPOC: `e2e` and `MegaLinter` are each around ten minutes, and #224 was still reporting
 * `PR-CHECK-UNSETTLED` with ten minutes configured.
 *
 * A malformed override must never make things worse. `Number("5m")` is NaN, and in the settle loop
 * the comparison `now - started >= NaN` is false forever - so a typo would convert this bounded wait
 * into an unbounded one. Anything that does not parse as a positive, finite number falls back.
 */
export const DEFAULT_PR_CHECKS_TIMEOUT_MS = 20 * 60_000;

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
