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
  error?: string;
}

/**
 * #354 — make the sandbox workspace a git work tree.
 *
 * The documented deployment requirement is an image that ALREADY carries the project (repo + deps),
 * so the clone is the absent-repo fallback. It has to run BEFORE the developer loop writes anything:
 * `git clone` refuses a non-empty target directory.
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
  // The documented image already carries the repo; only clone when it does not.
  if (inside.exitCode === 0) return { ok: true, cloned: false };

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
