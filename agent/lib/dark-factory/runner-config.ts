/**
 * Dark Factory — runner configuration (#348).
 *
 * Two concerns live here, deliberately kept apart:
 *
 *   RESOLUTION    — which repository this run works on.
 *   AUTHORIZATION — whether we may touch it (`DF_WORKER_ALLOWED_REPOS`, fail-closed, in `credentials.ts`).
 *
 * The runner used to answer the first with a literal, and fake the second by *setting* the allow-list
 * when it was unset — so an unconfigured deployment looked authorized. A default in code is
 * indistinguishable from a hardcode, which is exactly what #348 removes: the default is an operating
 * choice and lives in `dark-factory.config.json` as `default_repo`.
 */

/** The parts of `dark-factory.config.json` the runner needs. */
export interface RunnerConfig {
  /** `owner/name` from the config's `default_repo`, or absent when it sets none. */
  defaultRepo?: string;
}

/** Where the resolved repository came from, for the run's opening log. */
export type TargetRepoSource = "argument" | "config";

export type TargetRepoResult =
  | { ok: true; repo: string; source: TargetRepoSource }
  | { ok: false; error: string };

/** Not implemented yet (RED stub for #348 Task 1). */
export function resolveTargetRepo(input: {
  argv: readonly string[];
  config: RunnerConfig;
}): TargetRepoResult {
  void input;
  throw new Error("resolveTargetRepo is not implemented");
}
