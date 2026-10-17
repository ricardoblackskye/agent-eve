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

/** `array` rather than `object` for an array, so a type error names what the operator actually wrote. */
function describeValue(value: unknown): string {
  return Array.isArray(value) ? "array" : typeof value;
}

/**
 * Validate one repo's entry by SHAPE.
 *
 * Used at load time AND at use, because the loader is not the only door into `RunnerConfig`: a config
 * assembled in code never passes through it. A truthiness check here would accept `"3"`, a blank login, a
 * fractional number and a negative one, and every one of those then reaches a GitHub call.
 */
function validateEntry(
  value: unknown,
  path: string,
  repo: string,
): RepoSettingsResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {
      ok: false,
      error: `${path}: the entry for ${repo} must be an object (received ${describeValue(value)}).`,
    };
  }

  const record = value as Record<string, unknown>;
  const settings: RepoSettings = {};

  const board = record.board;
  if (board !== undefined) {
    if (board === null || typeof board !== "object" || Array.isArray(board)) {
      return {
        ok: false,
        error: `${path}: "board" for ${repo} must be an object with "login" and "number".`,
      };
    }

    const candidate = board as Record<string, unknown>;
    const login = candidate.login;
    const number = candidate.number;

    if (typeof login !== "string" || login.trim() === "") {
      return {
        ok: false,
        error: `${path}: "board.login" for ${repo} must be a non-empty string.`,
      };
    }
    if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) {
      return {
        ok: false,
        error: `${path}: "board.number" for ${repo} must be a positive integer (received ${JSON.stringify(number)}).`,
      };
    }

    settings.board = { login: login.trim(), number };
  }

  return { ok: true, settings };
}

/** The raw entry for a repo, matched without regard to case. Raw, so the caller re-validates it. */
function findRepoEntry(
  repos: Record<string, RepoSettings> | undefined,
  wanted: string,
): unknown {
  if (repos === undefined) return undefined;
  for (const [key, value] of Object.entries(repos)) {
    if (normalise(key) === wanted) return value;
  }
  return undefined;
}

/**
 * The settings for a repository, or a refusal.
 *
 * The refusal is the feature. Reporting to a board nobody configured is worse than not reporting: the
 * failure is silent, it lands on someone else's Project, and it looks intentional. So a repo with no entry
 * is refused with the repository AND the file to edit named in the message.
 */
export function resolveRepoSettings(input: {
  repo: string;
  config: RunnerConfig;
}): RepoSettingsResult {
  const wanted = normalise(input.repo);
  const entry = findRepoEntry(input.config.repos, wanted);

  if (entry === undefined) {
    return {
      ok: false,
      error:
        `No settings for repository ${input.repo} in ${RUNNER_CONFIG_PATH}. Add a ` +
        `"${wanted}" entry to that file - the Factory will not assume another repository's settings.`,
    };
  }

  return validateEntry(entry, RUNNER_CONFIG_PATH, wanted);
}

/**
 * The board a repository's work is reported to, or a refusal naming the repo and the file.
 *
 * Separate from `resolveRepoSettings` so the message can say what is missing: a repo may legitimately have
 * an entry without a board, and "no settings" would then be misleading.
 */
export function resolveBoard(input: {
  repo: string;
  config: RunnerConfig;
}): BoardResult {
  const settings = resolveRepoSettings(input);
  if (!settings.ok) return { ok: false, error: settings.error };

  if (settings.settings.board === undefined) {
    return {
      ok: false,
      error:
        `No board configured for ${input.repo} in ${RUNNER_CONFIG_PATH}. Add ` +
        '"board": { "login": "<owner>", "number": <n> } for it - refusing to report to a board ' +
        "nobody configured.",
    };
  }

  return { ok: true, board: settings.settings.board };
}

/** Which of the three sources a resolved value came from. */
export type SettingSource = "argument" | "env" | "config";

export type BoardSettingResult =
  | {
      ok: true;
      login: string;
      number: number;
      sources: { login: SettingSource; number: SettingSource };
    }
  | { ok: false; error: string };

/** One half of a resolution: a value with its source, genuinely absent, or present and wrong. */
type Resolved<T> =
  | { kind: "value"; value: T; source: SettingSource }
  | { kind: "absent" }
  | { kind: "invalid"; error: string };

/**
 * The login: explicit argument, then environment, then config.
 *
 * A BLANK value counts as unset and falls through, because an empty owner is not a choice anybody makes.
 * That is the opposite of the rule for the number below, deliberately: see `resolveNumber`.
 */
function resolveLogin(input: {
  explicit?: string;
  env: Record<string, string | undefined>;
  configured?: string;
}): Resolved<string> {
  if (input.explicit !== undefined && input.explicit.trim() !== "") {
    return { kind: "value", value: input.explicit.trim(), source: "argument" };
  }

  const fromEnv = input.env.SPRINT_PROJECT_OWNER;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { kind: "value", value: fromEnv.trim(), source: "env" };
  }

  if (input.configured !== undefined) {
    return { kind: "value", value: input.configured, source: "config" };
  }

  return { kind: "absent" };
}

/**
 * The project number: explicit argument, then environment, then config.
 *
 * A supplied-but-INVALID value is refused rather than treated as absent, because it is a choice someone
 * made and got wrong — falling through would quietly use a different board than the one they asked for. The
 * digits check is load-bearing: `Number()` accepts `"3.7"`, `"1e3"` and `" 3 "`, which is how a typo became
 * a board number nobody chose.
 */
function resolveNumber(input: {
  explicit?: number;
  env: Record<string, string | undefined>;
  configured?: number;
}): Resolved<number> {
  if (input.explicit !== undefined) {
    return Number.isInteger(input.explicit) && input.explicit > 0
      ? { kind: "value", value: input.explicit, source: "argument" }
      : {
          kind: "invalid",
          error: `projectNumber ${JSON.stringify(input.explicit)} is not a positive integer.`,
        };
  }

  const fromEnv = input.env.SPRINT_PROJECT_NUMBER;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    const raw = fromEnv.trim();
    if (!/^\d+$/.test(raw) || Number(raw) === 0) {
      return {
        kind: "invalid",
        error: `SPRINT_PROJECT_NUMBER ${JSON.stringify(fromEnv)} is not a positive integer.`,
      };
    }
    return { kind: "value", value: Number(raw), source: "env" };
  }

  if (input.configured !== undefined) {
    return { kind: "value", value: input.configured, source: "config" };
  }

  return { kind: "absent" };
}

/** One message naming every way to supply a board, so the refusal is actionable. */
function noBoardConfigured(repo: string, what: string): string {
  return (
    `No ${what} for repository ${repo}: pass it explicitly, set SPRINT_PROJECT_OWNER and ` +
    `SPRINT_PROJECT_NUMBER, or add a "board" entry for ${repo} in ${RUNNER_CONFIG_PATH}.`
  );
}

/**
 * Resolve a board from argument → environment → config, refusing when nothing supplies it.
 *
 * Each half resolves INDEPENDENTLY, because the two are genuinely separate settings and a caller may know
 * one without the other. A repo with no config entry is fine as long as the caller supplies both halves;
 * what is not fine is reporting to a board nobody configured, which is what the code being replaced did by
 * defaulting to number 3 for every repository.
 */
export function resolveBoardSetting(input: {
  repo: string;
  config: RunnerConfig;
  explicit?: { login?: string; number?: number };
  env?: Record<string, string | undefined>;
}): BoardSettingResult {
  const env = input.env ?? {};

  let configured: RepoBoardSettings | undefined;
  const entry = findRepoEntry(input.config.repos, normalise(input.repo));
  if (entry !== undefined) {
    const validated = validateEntry(entry, RUNNER_CONFIG_PATH, normalise(input.repo));
    if (!validated.ok) return { ok: false, error: validated.error };
    configured = validated.settings.board;
  }

  const login = resolveLogin({
    explicit: input.explicit?.login,
    env,
    configured: configured?.login,
  });
  if (login.kind === "invalid") return { ok: false, error: login.error };
  if (login.kind === "absent") {
    return { ok: false, error: noBoardConfigured(input.repo, "board owner") };
  }

  const number = resolveNumber({
    explicit: input.explicit?.number,
    env,
    configured: configured?.number,
  });
  if (number.kind === "invalid") return { ok: false, error: number.error };
  if (number.kind === "absent") {
    return { ok: false, error: noBoardConfigured(input.repo, "project number") };
  }

  return {
    ok: true,
    login: login.value,
    number: number.value,
    sources: { login: login.source, number: number.source },
  };
}

/** The first candidate that is present and not blank, trimmed. */
function firstNonBlank(...candidates: (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== "") return candidate.trim();
  }
  return undefined;
}

export type OwnerRepoResult =
  | { ok: true; owner: string; repo: string }
  | { ok: false; error: string };

/**
 * Resolve an `owner/repo` pair: explicit, then a platform env var, then the config's `default_repo`.
 *
 * `default_repo` is written as one `owner/name` (R1), so a single setting serves every consumer rather than
 * each tool keeping its own idea of a default. Where each half comes from is reported by the caller's own
 * logging rather than duplicated here.
 *
 * The refusal matters: a pair assembled from a literal is a repository nobody chose, and the whole class of
 * bug this epic removes is a wrong value that reads as a considered one.
 */
export function resolveOwnerRepo(input: {
  owner?: string;
  repo?: string;
  config: RunnerConfig;
  envOwnerValue?: string;
  envRepoValue?: string;
  env?: Record<string, string | undefined>;
}): OwnerRepoResult {
  const env = input.env ?? {};
  const [defaultOwner, defaultRepo] = (input.config.defaultRepo ?? "").split("/");

  const owner = firstNonBlank(input.owner, input.envOwnerValue, defaultOwner);
  const repo = firstNonBlank(input.repo, input.envRepoValue, defaultRepo);

  if (owner === undefined || repo === undefined) {
    return {
      ok: false,
      error:
        "No repository: pass owner and repo explicitly, or set " +
        `"default_repo" in ${RUNNER_CONFIG_PATH}.`,
    };
  }

  return { ok: true, owner, repo };
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

export type RunnerAnswerResult =
  | { ok: true; answer?: string }
  | { ok: false; error: string };

/**
 * The human's reply to a parked plan, read from `--answer-file` (#378).
 *
 * A FILE rather than an argument value: it keeps human text out of the process list and out of shell
 * quoting. The reader is injected, so resolution is testable without touching the disk.
 *
 * A named file that cannot be read is REFUSED, never reported as "no answer". Falling back to "no
 * answer" would make a revision reply indistinguishable from the label being cleared - it would turn
 * feedback into an approval, which is the exact failure the approval gate exists to prevent.
 */
export function resolveRunnerAnswer(input: {
  argv: readonly string[];
  readFile: (path: string) => string;
}): RunnerAnswerResult {
  const argument = flagValue(input.argv, "--answer-file");
  if (!argument.present) return { ok: true };

  const path = (argument.value ?? "").trim();
  if (path === "") {
    return { ok: false, error: "No answer file: pass --answer-file <path>." };
  }

  try {
    return { ok: true, answer: input.readFile(path) };
  } catch (error) {
    return {
      ok: false,
      error: `--answer-file ${JSON.stringify(path)} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
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

  const record = parsed as Record<string, unknown>;
  const config: RunnerConfig = {};

  const defaultRepo = record.default_repo;
  if (defaultRepo !== undefined) {
    if (typeof defaultRepo !== "string") {
      return {
        ok: false,
        error: `${path}: "default_repo" must be a string (received ${describeValue(defaultRepo)}).`,
      };
    }

    const trimmed = defaultRepo.trim();
    if (!REPO_PAIR_PATTERN.test(trimmed)) {
      return {
        ok: false,
        error:
          `${path}: "default_repo" ${JSON.stringify(defaultRepo)} is not an owner/repo pair ` +
          "(expected e.g. owner/name).",
      };
    }

    config.defaultRepo = trimmed;
  }

  const repos = record.repos;
  if (repos !== undefined) {
    if (repos === null || typeof repos !== "object" || Array.isArray(repos)) {
      return {
        ok: false,
        error:
          `${path}: "repos" must be an object keyed by owner/repo ` +
          `(received ${describeValue(repos)}).`,
      };
    }

    const entries: Record<string, RepoSettings> = {};
    for (const [key, entry] of Object.entries(repos as Record<string, unknown>)) {
      const repo = key.trim();
      if (!REPO_PAIR_PATTERN.test(repo)) {
        return {
          ok: false,
          error:
            `${path}: repos key ${JSON.stringify(key)} is not an owner/repo pair ` +
            "(expected e.g. owner/name).",
        };
      }

      const validated = validateEntry(entry, path, repo);
      if (!validated.ok) return validated;

      entries[key] = validated.settings;
    }

    config.repos = entries;
  }

  return { ok: true, config };
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
