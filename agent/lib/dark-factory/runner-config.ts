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

import { readFileSync } from "node:fs";

import { REPO_PAIR_PATTERN } from "./credentials";

/** Where the config file is expected, relative to the working directory. */
export const RUNNER_CONFIG_PATH = "dark-factory.config.json";

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

/**
 * `--flag`'s value, distinguishing "not supplied" from "supplied with nothing after it".
 *
 * The distinction is the whole point: a bare trailing `--repo` is a mistake, and silently falling back
 * to the configured default would run against a repository the caller did not ask for. The runner's
 * other arguments use `argv.indexOf` inline; this is the same shape with the ambiguity removed.
 */
function flagValue(
  argv: readonly string[],
  flag: string,
): { present: boolean; value?: string } {
  const index = argv.indexOf(flag);
  if (index === -1) return { present: false };
  return { present: true, value: argv[index + 1] };
}

/**
 * `owner/name`, lower-cased and trimmed.
 *
 * GitHub treats owner casing as insignificant and `resolveWorkerAllowedRepos` lower-cases its entries,
 * so lower-casing here is what lets the two agree about identity. Not cosmetic: skip it and a
 * correctly-authorized repository fails its own membership check.
 */
function normalise(value: string): string {
  return value.trim().toLowerCase();
}

export type RunnerConfigResult =
  | { ok: true; config: RunnerConfig }
  | { ok: false; error: string };

export type TargetRepoAuthorization = { ok: true } | { ok: false; error: string };

/** Not implemented yet (RED stub for #348 Task 3). */
export function authorizeTargetRepo(_input: {
  repo: string;
  allowed: readonly string[];
}): TargetRepoAuthorization {
  throw new Error("authorizeTargetRepo is not implemented");
}

/**
 * Parse the config text.
 *
 * Validates the FORM and returns the value as written: lower-casing belongs to resolution, so ONE place
 * decides what repository identity means rather than two that can drift apart.
 */
export function parseRunnerConfig(
  raw: string,
  path: string = RUNNER_CONFIG_PATH,
): RunnerConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${path} is not valid JSON.` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `${path} must contain a JSON object.` };
  }

  const value = (parsed as Record<string, unknown>).default_repo;
  if (value === undefined) return { ok: true, config: {} };

  if (typeof value !== "string") {
    return {
      ok: false,
      error:
        `${path}: "default_repo" must be a string (received ` +
        `${Array.isArray(value) ? "array" : typeof value}).`,
    };
  }

  const trimmed = value.trim();
  if (!REPO_PAIR_PATTERN.test(trimmed)) {
    return {
      ok: false,
      error:
        `${path}: "default_repo" ${JSON.stringify(value)} is not an owner/repo pair ` +
        "(expected e.g. owner/name).",
    };
  }

  return { ok: true, config: { defaultRepo: trimmed } };
}

/**
 * Read the config from disk.
 *
 * The read is injectable, so the tests never touch the filesystem. A MISSING file is "no default" rather
 * than a failure: `--repo` alone is legitimate, and with neither the resolver refuses — turning absence
 * into a startup error here would break a legitimate run.
 */
export function loadRunnerConfig(
  deps: { readFile?: (path: string) => string; path?: string } = {},
): RunnerConfigResult {
  const path = deps.path ?? RUNNER_CONFIG_PATH;
  const read = deps.readFile ?? ((target: string) => readFileSync(target, "utf8"));

  let raw: string;
  try {
    raw = read(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: true, config: {} };
    }
    return { ok: false, error: `Could not read ${path}: ${(error as Error).message}` };
  }

  return parseRunnerConfig(raw, path);
}

/**
 * Decide the target repository: an explicit `--repo` wins, else the configured default, else refuse.
 *
 * The config's default is validated here as well as where it is loaded, because a `RunnerConfig` built
 * in code never passes through the loader — the loader is not the only door into this function.
 */
export function resolveTargetRepo(input: {
  argv: readonly string[];
  config: RunnerConfig;
}): TargetRepoResult {
  const argument = flagValue(input.argv, "--repo");

  if (argument.present) {
    const value = normalise(argument.value ?? "");
    if (!REPO_PAIR_PATTERN.test(value)) {
      return {
        ok: false,
        error:
          `--repo ${JSON.stringify(argument.value ?? "")} is not an owner/repo pair ` +
          "(expected e.g. owner/name).",
      };
    }
    return { ok: true, repo: value, source: "argument" };
  }

  const configured = input.config.defaultRepo;
  if (configured !== undefined) {
    const value = normalise(configured);
    if (!REPO_PAIR_PATTERN.test(value)) {
      return {
        ok: false,
        error:
          `default_repo ${JSON.stringify(configured)} in ${RUNNER_CONFIG_PATH} is not an ` +
          "owner/repo pair (expected e.g. owner/name).",
      };
    }
    return { ok: true, repo: value, source: "config" };
  }

  return {
    ok: false,
    error:
      `No target repository: pass --repo <owner/name>, or set "default_repo" in ` +
      `${RUNNER_CONFIG_PATH}.`,
  };
}
