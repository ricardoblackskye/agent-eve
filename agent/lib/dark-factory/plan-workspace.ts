/**
 * The PLAN WORKSPACE gate (#405).
 *
 * Planning must read a checkout of the TARGET repository. The Architect used to infer its root from
 * `process.cwd()`, so a run launched from anywhere else planned against that directory instead - the
 * refusal in the #169 probe was correct behavior and the wrong input.
 *
 * The evidence of identity is the checkout's `origin` remote, not its path: a path says where a
 * directory is, a remote says which repository it is. A candidate that cannot be shown to be the
 * target is REFUSED rather than used, because the harm is a confidently wrong plan: discovery numbers
 * describe the wrong repository and every page-scoped story parks.
 */

export interface PlanWorkspaceInput {
  /** The target repository, as `owner/repo`. */
  targetRepo: string;
  /** The directory the runner was started in. */
  cwd: string;
  /** An explicit choice (`--workspace` or `DF_PLAN_WORKSPACE`); still verified. */
  override?: string | undefined;
  /** `git remote get-url origin` for a directory, or null when it is not a checkout. Injected. */
  remoteOf: (dir: string) => string | null;
}

export type PlanWorkspaceSource = "override" | "cwd";

export type PlanWorkspaceResult =
  | { ok: true; path: string; source: PlanWorkspaceSource }
  | { ok: false; problems: string[] };

/**
 * Reduce a repository reference to a comparable `owner/repo`, lowercased.
 *
 * Accepts the forms git actually stores in `origin`: an https URL, an ssh URL, scp-like
 * `git@host:owner/repo`, with or without a trailing `.git` or slash. Returns null when the value
 * does not name two path segments, so an unparseable remote is never read as a match.
 */
export function normalizeRepo(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (text === "") return null;

  text = text.replace(/\/+$/, "");
  text = text.replace(/\.git$/i, "");

  const scpLike = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(text);
  if (scpLike) {
    text = scpLike[1]!;
  } else {
    const url = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+\/(.+)$/.exec(text);
    if (url) text = url[1]!;
  }

  const segments = text
    .replace(/^\/+/, "")
    .split("/")
    .filter((segment) => segment !== "");

  if (segments.length < 2) return null;
  return segments.slice(-2).join("/").toLowerCase();
}

function refusal(candidate: string, targetRepo: string, reason: string): PlanWorkspaceResult {
  return {
    ok: false,
    problems: [
      `The plan workspace cannot be justified: ${reason}`,
      "",
      `  candidate: ${candidate}`,
      `  target:    ${targetRepo}`,
      "",
      "Planning reads this directory, so a wrong one produces a plan about the wrong repository.",
      `  Fix: run through scripts/dark-factory-local-run.ts, which clones the target before planning,`,
      `  or pass --workspace <dir> naming a checkout whose origin is ${targetRepo}.`,
    ],
  };
}

export function resolvePlanWorkspace(input: PlanWorkspaceInput): PlanWorkspaceResult {
  const override = input.override?.trim();
  const source: PlanWorkspaceSource = override ? "override" : "cwd";
  const candidate = override ? override : input.cwd;

  const wants = normalizeRepo(input.targetRepo);
  if (wants === null) {
    return refusal(candidate, input.targetRepo, `${input.targetRepo} does not name an owner/repo`);
  }

  const remote = input.remoteOf(candidate);
  if (remote === null || remote === undefined) {
    return refusal(
      candidate,
      input.targetRepo,
      `${candidate} is not a git checkout (no origin remote)`,
    );
  }

  const found = normalizeRepo(remote);
  if (found === null) {
    return refusal(
      candidate,
      input.targetRepo,
      `${candidate} has an origin remote that does not name a repository (${remote})`,
    );
  }

  if (found !== wants) {
    return refusal(
      candidate,
      input.targetRepo,
      `${candidate} is a checkout of ${found}, not ${input.targetRepo}`,
    );
  }

  return { ok: true, path: candidate, source };
}

/** The Architect's reader, rooted at one directory. */
export interface WorkspaceReader {
  listFiles: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
}

export function createWorkspaceReader(root: string): WorkspaceReader {
  throw new Error("not implemented");
}
