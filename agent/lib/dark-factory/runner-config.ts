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

/** Where a repository's work is reported, when the Project has a board. */
export interface RepoBoardSettings {
  /** The Project's owner login. */
  login: string;
  /** The Project's number. */
  number: number;
}

/** The per-repo settings the Factory reads. Only fields something consumes. */
export interface RepoSettings {
  board?: RepoBoardSettings;
}

/** The parts of `dark-factory.config.json` the runner needs. */
export interface RunnerConfig {
  /** `owner/name` from the config's `default_repo`, or absent when it sets none. */
  defaultRepo?: string;
  /** Per-repo settings, keyed `owner/name` as written in the file. */
  repos?: Record<string, RepoSettings>;
}

export type RepoSettingsResult =
  | { ok: true; settings: RepoSettings }
  | { ok: false; error: string };

export type BoardResult =
  | { ok: true; board: RepoBoardSettings }
  | { ok: false; error: string };

/** Not implemented yet (RED stub for #348 R2 Task 1). */
export function resolveRepoSettings(_input: {
  repo: string;
  config: RunnerConfig;
}): RepoSettingsResult {
  throw new Error("resolveRepoSettings is not implemented");
}

/** Not implemented yet (RED stub for #348 R2 Task 1). */
export function resolveBoard(_input: {
  repo: string;
  config: RunnerConfig;
}): BoardResult {
  throw new Error("resolveBoard is not implemented");
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

/**
 * Decide whether a repository may be touched at all.
 *
 * Fail-closed in the same way as the rest of the Factory: an unset allow-list authorizes NOTHING, and the
 * message names the variable rather than reporting a generic refusal. The runner used to make this path
 * unreachable by setting the variable when it was unset, which turned "not configured" into "authorized".
 *
 * Comparison ignores case because `resolveWorkerAllowedRepos` lower-cases its entries: a caller that
 * supplies the configured casing must not be refused on spelling.
 */
export function authorizeTargetRepo(input: {
  repo: string;
  allowed: readonly string[];
}): TargetRepoAuthorization {
  if (input.allowed.length === 0) {
    return {
      ok: false,
      error:
        "DF_WORKER_ALLOWED_REPOS is not configured, so no repository is authorized " +
        "(fail-closed). Set it to a comma-separated list of owner/repo entries.",
    };
  }

  const repo = input.repo.trim().toLowerCase();
  const allowed = input.allowed.map((entry) => entry.trim().toLowerCase());

  if (!allowed.includes(repo)) {
    return {
      ok: false,
      error:
        `repository ${input.repo} is not in DF_WORKER_ALLOWED_REPOS ` +
        `(${input.allowed.join(", ")}).`,
    };
  }

  return { ok: true };
}

export type IssueNumberResult =
  | { ok: true; issue: number }
  | { ok: false; error: string };

export type BranchNameResult =
  | { ok: true; branch: string }
  | { ok: false; error: string };

/**
 * The issue number, which must be supplied explicitly.
 *
 * The runner used to default this to 179: a run against an issue nobody asked for, with nothing in the
 * output saying so. Digits are matched rather than passed to `parseInt`, which COERCES instead of
 * validating — `parseInt("34.8")` is 34 and `parseInt("12abc")` is 12 — so a typo would silently become a
 * real issue number and the run would look intentional.
 */
export function resolveIssueNumber(argv: readonly string[]): IssueNumberResult {
  const argument = flagValue(argv, "--issue");
  const raw = (argument.value ?? "").trim();

  if (!argument.present || raw === "") {
    return { ok: false, error: "No issue number: pass --issue <number>." };
  }

  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      error: `--issue ${JSON.stringify(argument.value)} is not a positive integer.`,
    };
  }

  return { ok: true, issue: Number(raw) };
}

/**
 * The branch to work on: an explicit `--branch`, else one derived from the issue.
 *
 * Branch names must not contain `#` — it breaks the GitHub UI and URLs, and this repo's own convention
 * forbids it. The previous default (`feat/dark-factory-#${issue}`) did exactly that.
 */
export function resolveBranchName(input: {
  argv: readonly string[];
  issue: number;
}): BranchNameResult {
  const argument = flagValue(input.argv, "--branch");
  const raw = (argument.value ?? "").trim();

  if (argument.present) {
    if (raw === "") {
      return { ok: false, error: "No branch name: pass --branch <name>." };
    }
    if (raw.includes("#")) {
      return {
        ok: false,
        error: `--branch ${JSON.stringify(raw)} contains '#', which breaks GitHub URLs and this repo's naming convention.`,
      };
    }
    return { ok: true, branch: raw };
  }

  return { ok: true, branch: `feat/dark-factory-${input.issue}` };
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
