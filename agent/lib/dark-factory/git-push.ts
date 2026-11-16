import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProviderKey } from "./provider-key";
import type { CredentialVault } from "./credential-vault";

export interface GitPushCommand {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface BuildGitPushCommandArgs {
  owner: string;
  repo: string;
  branchName: string;
  askpassPath: string;
}

/**
 * Pure, secret-free push command builder. The token is NEVER placed in the remote URL or in argv; it
 * is supplied to git only via an askpass helper (a path, not the value). The remote URL is the bare
 * https form.
 */
export function buildGitPushCommand(
  args: BuildGitPushCommandArgs,
): GitPushCommand {
  const remote = `https://github.com/${args.owner}/${args.repo}.git`;
  return {
    cmd: "git",
    args: ["push", remote, args.branchName],
    env: {
      ...process.env,
      GIT_ASKPASS: args.askpassPath,
      GIT_USERNAME: "x-access-token",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
}

export interface GitPushWithVaultArgs {
  owner: string;
  repo: string;
  branchName: string;
  vault: CredentialVault;
  tokenName?: string;
}

type ExecFn = (
  command: string,
  options?: { env?: NodeJS.ProcessEnv; stdio?: unknown },
) => string | Buffer;

/**
 * Server-side redeem of the push token from the write-only vault; the authed URL is never built. The
 * token briefly lives only in a 0600 temp file read by the askpass helper, never in argv or logs.
 */
export async function gitPushWithVault(
  args: GitPushWithVaultArgs,
  exec: ExecFn = execSync,
): Promise<void> {
  const tokenName = args.tokenName ?? "git-push-token";
  const token = await resolveProviderKey({
    vault: args.vault,
    credentialName: tokenName,
    scope: { repos: ["git-push"] },
  });
  const dir = mkdtempSync(join(tmpdir(), "df-push-"));
  const tokenPath = join(dir, "token");
  const askpassPath = join(dir, "askpass.sh");
  writeFileSync(tokenPath, token, { mode: 0o600 });
  writeFileSync(
    askpassPath,
    `#!/usr/bin/env bash\necho "x-access-token"\necho "$(cat "${tokenPath}")"\n`,
    { mode: 0o700 },
  );
  const {
    cmd,
    args: pushArgs,
    env,
  } = buildGitPushCommand({
    owner: args.owner,
    repo: args.repo,
    branchName: args.branchName,
    askpassPath,
  });
  try {
    exec(`${cmd} ${pushArgs.join(" ")}`, { env, stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** #354 — one git command executed INSIDE the sandbox (the vault path's `runGit`). */
export type SandboxGitRunner = (
  args: string[],
) => Promise<{ exitCode: number; output: string }>;

export interface SandboxRepoDeps {
  runGit: SandboxGitRunner;
  /** Bare https clone URL — NO userinfo: the sidecar supplies the credential. */
  remoteUrl: string;
  /** Absolute workspace root INSIDE the sandbox. */
  workspaceDir: string;
}

export interface SandboxRepoResult {
  ok: boolean;
  /** True when this call performed the clone (the image did not already carry the repo). */
  cloned: boolean;
  /**
   * The commit the checkout sat at before the sync, and the default-branch tip it was moved to (#657).
   *
   * Absent on the clone path, where the clone already lands on the default tip.
   */
  base?: { before: string; after: string };
  error?: string;
}

/**
 * #354 — make the sandbox workspace a git work tree, at the CURRENT default branch.
 *
 * The documented deployment requirement is an image that ALREADY carries the project (repo + deps),
 * so the clone is the absent-repo fallback. It has to run BEFORE the developer loop writes anything:
 * `git clone` refuses a non-empty target directory.
 *
 * #657 — a carried-over checkout is only a HEAD, so it must be moved to the current
 * `origin/<default>` before it is used. The run branch is cut later by `git checkout -B <branch>`,
 * which starts from HEAD; syncing is what stops the branch being cut from whatever the image was built
 * with. A real run shipped a merge base of 15f22ed (2026-09-08) against a target whose main was
 * 9b9e47d (2026-11-02), and a run that passes its tests against a two-month-old tree can reintroduce
 * code main has already fixed.
 *
 * The ORDERING is why this belongs here rather than in `commitAndPushFromSandbox`: the reset DISCARDS
 * local changes, so running it after the coding loop would destroy the developer's work. It is a fetch
 * plus a hard reset, never a clean, so the image's untracked build output (`node_modules`) survives.
 */
export async function ensureSandboxRepo(
  deps: SandboxRepoDeps,
): Promise<SandboxRepoResult> {
  const inside = await deps.runGit([
    "-C",
    deps.workspaceDir,
    "rev-parse",
    "--is-inside-work-tree",
  ]);

  // An image without the repo: clone, and the clone already lands on the default tip.
  if (inside.exitCode !== 0) {
    const clone = await deps.runGit(["clone", deps.remoteUrl, deps.workspaceDir]);
    if (clone.exitCode !== 0) {
      return {
        ok: false,
        cloned: false,
        error: `git clone failed (exit ${clone.exitCode}): ${clone.output}`,
      };
    }
    return { ok: true, cloned: true };
  }

  // The documented image already carries the repo: take it to the current default branch instead of
  // coding against the HEAD it shipped with.
  const before = await deps.runGit(["-C", deps.workspaceDir, "rev-parse", "HEAD"]);
  if (before.exitCode !== 0) {
    return {
      ok: false,
      cloned: false,
      error: `could not read the checkout's current commit (exit ${before.exitCode}): ${before.output}`,
    };
  }

  const fetched = await deps.runGit(["-C", deps.workspaceDir, "fetch", "origin", "--prune"]);
  if (fetched.exitCode !== 0) {
    return {
      ok: false,
      cloned: false,
      error: `git fetch failed (exit ${fetched.exitCode}): ${fetched.output}`,
    };
  }

  // An image's origin/HEAD can be stale or absent, so refresh it from the refs just fetched rather
  // than guessing a branch name.
  const setHead = await deps.runGit([
    "-C",
    deps.workspaceDir,
    "remote",
    "set-head",
    "origin",
    "--auto",
  ]);
  if (setHead.exitCode !== 0) {
    return {
      ok: false,
      cloned: false,
      error: `could not refresh origin/HEAD (exit ${setHead.exitCode}): ${setHead.output}`,
    };
  }

  const head = await deps.runGit([
    "-C",
    deps.workspaceDir,
    "rev-parse",
    "--abbrev-ref",
    "refs/remotes/origin/HEAD",
  ]);
  const defaultBranch = head.output.trim();
  if (head.exitCode !== 0 || defaultBranch === "") {
    return {
      ok: false,
      cloned: false,
      error: `could not resolve the default branch from origin/HEAD (exit ${head.exitCode}): ${head.output}`,
    };
  }

  const reset = await deps.runGit(["-C", deps.workspaceDir, "reset", "--hard", defaultBranch]);
  if (reset.exitCode !== 0) {
    return {
      ok: false,
      cloned: false,
      error: `git reset to ${defaultBranch} failed (exit ${reset.exitCode}): ${reset.output}`,
    };
  }

  const after = await deps.runGit(["-C", deps.workspaceDir, "rev-parse", "HEAD"]);
  return {
    ok: true,
    cloned: false,
    base: { before: before.output.trim(), after: after.output.trim() },
  };
}

export interface SandboxCommitDeps extends SandboxRepoDeps {
  branchName: string;
  commitMessage: string;
  /** Explicit paths: an untracked helper file must never be swept into the commit. */
  filesToAdd: string[];
}

/**
 * #354 — commit the agent's work and push it, INSIDE the sandbox, so the push credential exists only
 * as a vault binding the egress sidecar injects. Runs AFTER the loop and BEFORE the sandbox is
 * disposed, because the sandbox does not outlive the coding phase.
 */
export async function commitAndPushFromSandbox(
  deps: SandboxCommitDeps,
): Promise<SandboxRepoResult> {
  const run = (...args: string[]) =>
    deps.runGit(["-C", deps.workspaceDir, ...args]);

  // A throwaway branch per run, so a re-run cannot accumulate onto a previous attempt.
  const checkout = await run("checkout", "-B", deps.branchName);
  if (checkout.exitCode !== 0) {
    return {
      ok: false,
      cloned: false,
      error: `git checkout failed (exit ${checkout.exitCode}): ${checkout.output}`,
    };
  }
  // EXPLICIT paths: an untracked helper in the workspace must not be swept into the commit.
  const add = await run("add", "--", ...deps.filesToAdd);
  if (add.exitCode !== 0) {
    return {
      ok: false,
      cloned: false,
      error: `git add failed (exit ${add.exitCode}): ${add.output}`,
    };
  }
  const commit = await run("commit", "-m", deps.commitMessage);
  if (commit.exitCode !== 0) {
    return {
      ok: false,
      cloned: false,
      error: `git commit failed (exit ${commit.exitCode}): ${commit.output}`,
    };
  }
  // The ONLY step that needs a credential, and it carries none: the egress sidecar injects the
  // Authorization header for the host+path the vault binding is scoped to.
  const push = await run("push", deps.remoteUrl, deps.branchName);
  if (push.exitCode !== 0) {
    return {
      ok: false,
      cloned: false,
      error: `git push failed (exit ${push.exitCode}): ${push.output}`,
    };
  }
  return { ok: true, cloned: false };
}
