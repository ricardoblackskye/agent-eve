import { isAbsolute, join, relative, sep } from "node:path";

/**
 * The CHECKOUT PLANNER (#404 R1 Task 3).
 *
 * A local run's working directory must be a checkout of the TARGET repository, because discovery reads
 * `process.cwd()` (#405) — my own E2E scanned agent-eve while the story was about WebFeedPOC. This module decides
 * that directory and how to produce it.
 *
 * It exists as its own module for one security reason, learned by finding a real token on disk: a clone made with
 * a credential in its URL PERSISTS that credential in `.git/config`. So the URL here is always the clean public
 * one, and authentication arrives through `gitAuthEnv` for the single git invocation — never in argv (visible in a
 * process list) and never written to disk.
 *
 * The planner deliberately never sees a credential: the caller composes the two.
 */
export interface CheckoutPlanInput {
  /** The target repository as `owner/repo`. */
  repo: string;
  /** Where per-issue workspaces live. */
  workspaceRoot: string;
  /** Whether a path already exists — injected, so the planner needs no filesystem. */
  exists: (path: string) => boolean;
  issue: number;
}

export interface CheckoutPlan {
  /** The directory the child process must run in. */
  path: string;
  /** True when the plan expects the caller to clone; false when an existing checkout is reused. */
  mustClone: boolean;
  /** `git` arguments: the URL carries NO credential. Empty when no clone is needed. */
  cloneArgs: string[];
  /** A rendering safe to print: paths and a command, never a secret. */
  summary: string;
}

/** Anything that is not plainly safe in a single path segment. A repository name is untrusted input. */
const UNSAFE_SEGMENT = /[^A-Za-z0-9._-]/g;

/**
 * Containment by `path.relative`, never by a string prefix.
 *
 * `path.resolve` does not normalise case, so a prefix compare false-rejects a legitimate path whose drive letter
 * differs — and on Windows a case-insensitive filesystem makes the prefix test subtly wrong in the other
 * direction. `relative` follows the platform instead.
 */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function workspaceName(repo: string, issue: number): string {
  const repoName = repo.split("/").pop() ?? "repo";
  const safe = repoName.replace(UNSAFE_SEGMENT, "-").replace(/\.{2,}/g, "-");
  const trimmed = safe.replace(/^[.-]+/, "");
  return `${(trimmed === "" ? "repo" : trimmed).toLowerCase()}-${issue}`;
}

export interface ProvisionPlan {
  /** The `npm` arguments, or empty when nothing should run. */
  installArgs: string[];
  /** A rendering safe to print: a command, never a secret. */
  summary: string;
}

/**
 * Decide how to provision a checkout that has JUST been cloned (#541).
 *
 * This cannot be decided before the clone. A fresh workspace has no files at all, so asking whether a lockfile
 * exists pre-clone answers NO for every repository — which is exactly how the first version of this fix silently
 * installed nothing while its unit test passed, because the test injected an `exists` that said YES for a path
 * that could not exist yet. Decisions whose input is an effect must be taken after the effect.
 *
 * Post-clone, against the real tree, the rule stays pure by taking `exists` as an argument.
 */
export function planProvisioning(input: {
  path: string;
  exists: (path: string) => boolean;
}): ProvisionPlan {
  const { path, exists } = input;
  // A lockfile means a reproducible `npm ci`; a manifest alone means `npm install`; neither means this is not a
  // Node project, and `npm ci` there would fail the run for a reason unrelated to the story.
  const installArgs = exists(join(path, "package-lock.json"))
    ? ["ci"]
    : exists(join(path, "package.json"))
      ? ["install"]
      : [];
  const summary = installArgs.length
    ? `provision the checkout with npm ${installArgs.join(" ")}`
    : "the checkout needs no provisioning";
  return { installArgs, summary };
}

export function planCheckout(input: CheckoutPlanInput): CheckoutPlan {
  const { repo, workspaceRoot, exists, issue } = input;
  const path = join(workspaceRoot, workspaceName(repo, issue));

  // Fail closed rather than run somewhere unexpected: a workspace outside its root would put the child's writes
  // somewhere nobody chose.
  if (!isInside(workspaceRoot, path)) {
    throw new Error(`refusing a workspace outside ${workspaceRoot}: ${path}`);
  }

  const mustClone = !exists(path);
  // The URL is the CLEAN public one. Whatever credentials the run needs arrive through gitAuthEnv for this single
  // invocation, so nothing is persisted in the checkout's config.
  const cloneArgs = mustClone
    ? ["clone", "--depth", "1", `https://github.com/${repo}.git`, path]
    : [];

  const summary = mustClone
    ? `clone ${repo} into ${path} (credentials come from the environment, never from the URL)`
    : `reuse the checkout already at ${path}`;

  // Provisioning is deliberately NOT decided here (#541). A fresh workspace has no files at all, so a pre-clone
  // lockfile check answers NO for every repository — and the install then silently never runs. The caller asks
  // planProvisioning() once the clone exists.
  return { path, mustClone, cloneArgs, summary };
}

/**
 * The environment for ONE git invocation, authenticating without putting the credential in the URL or in argv.
 *
 * `GIT_CONFIG_COUNT` is git's own mechanism for per-invocation config, so nothing is written to any config file
 * and nothing appears in a process list. The credential is base64 of `x-access-token:<token>`, which is how a
 * GitHub App installation token is presented.
 */
export function gitAuthEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}
