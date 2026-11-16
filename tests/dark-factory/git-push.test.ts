import { describe, expect, it, vi } from "vitest";
import { createInMemoryCredentialVault } from "../../agent/lib/dark-factory/credential-vault";
import {
  buildGitPushCommand,
  commitAndPushFromSandbox,
  ensureSandboxRepo,
  gitPushWithVault,
} from "../../agent/lib/dark-factory/git-push";

describe("buildGitPushCommand", () => {
  it("builds a secret-free push: bare URL, token only via an askpass path", () => {
    const { args, env } = buildGitPushCommand({
      owner: "o",
      repo: "r",
      branchName: "df-1",
      askpassPath: "/tmp/askpass.sh",
    });
    expect(args).toEqual(["push", "https://github.com/o/r.git", "df-1"]);
    expect(args.join(" ")).not.toContain("x-access-token:"); // no credential in the URL
    expect(env.GIT_ASKPASS).toBe("/tmp/askpass.sh");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(JSON.stringify(env)).not.toContain("ghp_secret"); // token never in env
  });
});

describe("gitPushWithVault", () => {
  it("redeems the token from the vault and never places it in argv", async () => {
    const vault = createInMemoryCredentialVault({ allowList: ["git-push"] });
    await vault.put("git-push-token", "ghp_secret_value");
    let captured = "";
    const fakeExec = vi.fn((cmd: string) => {
      captured = cmd;
      return "";
    });
    await gitPushWithVault(
      {
        owner: "o",
        repo: "r",
        branchName: "df-9",
        vault,
        tokenName: "git-push-token",
      },
      fakeExec as never,
    );
    expect(captured).toContain("push https://github.com/o/r.git df-9");
    expect(captured).not.toContain("ghp_secret_value");
    expect(captured).not.toContain("x-access-token:");
    expect(fakeExec).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the vault has no push token (no secret in the rejection)", async () => {
    const vault = createInMemoryCredentialVault({ allowList: ["git-push"] });
    await expect(
      gitPushWithVault(
        { owner: "o", repo: "r", branchName: "df-9", vault },
        vi.fn() as never,
      ),
    ).rejects.toThrow();
  });
});

/**
 * Programs exit codes so the flow can be driven with no sandbox and no repository.
 *
 * `print` supplies what a successful command returns; it is optional and defaults to empty output, so the
 * existing cases read unchanged.
 */
function fakeRunGit(
  fail: (args: string[]) => boolean = () => false,
  print: (args: string[]) => string = () => "",
) {
  const calls: string[][] = [];
  const runGit = vi.fn(async (args: string[]) => {
    calls.push(args);
    const failed = fail(args);
    return {
      exitCode: failed ? 1 : 0,
      output: failed ? `failed: ${args.join(" ")}` : print(args),
    };
  });
  return { runGit, calls };
}

const url = "https://github.com/ricardoblackskye/agent-eve.git";
const ws = "/workspace";

/**
 * #354 — the VAULT-path git flow, executed INSIDE the sandbox.
 *
 * A clone cannot target a non-empty directory, so the flow is split: ensure the repo BEFORE the
 * developer loop writes anything, then commit and push AFTER it — both before the sandbox is
 * disposed, because `runCodingPhase` disposes it at the end of the coding phase.
 */
describe("#354 ensureSandboxRepo", () => {
  it("clones when the workspace is not yet a work tree (image without the repo)", async () => {
    const { runGit, calls } = fakeRunGit((args) => args.includes("rev-parse"));
    const res = await ensureSandboxRepo({ runGit, remoteUrl: url, workspaceDir: ws });
    expect(res).toEqual({ ok: true, cloned: true });
    expect(calls).toEqual([
      ["-C", ws, "rev-parse", "--is-inside-work-tree"],
      ["clone", url, ws],
    ]);
    // The clone URL carries no userinfo: there is no credential inside it to leak.
    expect(calls[1]!.join(" ")).not.toContain("@");
  });

  it("does NOT clone when the image already carries the repo", async () => {
    const { runGit, calls } = fakeRunGit(() => false, (args) =>
      args.includes("--abbrev-ref") ? "origin/main" : "",
    );
    const res = await ensureSandboxRepo({ runGit, remoteUrl: url, workspaceDir: ws });
    expect(res).toMatchObject({ ok: true, cloned: false });
    // The stated point of this case: no clone. The sync it performs INSTEAD is pinned by the #657 tests.
    expect(calls.some((c) => c[0] === "clone")).toBe(false);
  });

  it("reports a failed clone instead of throwing", async () => {
    const { runGit } = fakeRunGit(
      (args) => args.includes("rev-parse") || args[0] === "clone",
    );
    const res = await ensureSandboxRepo({ runGit, remoteUrl: url, workspaceDir: ws });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/clone/i);
  });
});

describe("#354 commitAndPushFromSandbox", () => {
  const deps = {
    workspaceDir: ws,
    branchName: "feat/df-sandbox-vault-push-354",
    commitMessage: "feat: #354 vault push",
    filesToAdd: ["agent/x.ts"],
    remoteUrl: url,
  };

  it("checks out the run branch, stages explicit paths, commits and pushes, in order", async () => {
    const { runGit, calls } = fakeRunGit();
    const res = await commitAndPushFromSandbox({ ...deps, runGit });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      ["-C", ws, "checkout", "-B", deps.branchName],
      ["-C", ws, "add", "--", "agent/x.ts"],
      ["-C", ws, "commit", "-m", deps.commitMessage],
      ["-C", ws, "push", url, deps.branchName],
    ]);
    // No userinfo anywhere in the sequence: the token is a vault binding, not a URL component.
    expect(calls.flat().join(" ")).not.toContain("@");
  });

  it("reports a failed push instead of throwing, so the runner can fail the run loudly", async () => {
    const { runGit } = fakeRunGit((args) => args.includes("push"));
    const res = await commitAndPushFromSandbox({ ...deps, runGit });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/push/i);
  });
});

/**
 * #657 - a carried-over checkout must be brought to the CURRENT default branch.
 *
 * The documented image ships a repo baked in, and `ensureSandboxRepo` used to treat that as "ready". A
 * real run then cut its branch from the image's HEAD: WebFeedPOC#204's branch had a merge base of
 * 15f22ed (2026-09-08) while the target's main was 9b9e47d (2026-11-02). A run that passes its tests
 * against a two-month-old tree can reintroduce code main has already fixed, so the checkout is synced
 * BEFORE the coding loop writes anything - a reset afterwards would destroy the developer's work.
 */
describe("#657 ensureSandboxRepo syncs a carried-over checkout to the default branch", () => {
  const mainTip = "9b9e47d0000000000000000000000000000000";
  const bakedHead = "15f22ed0000000000000000000000000000000";

  /** The two `rev-parse HEAD` reads: the first is the baked base, the second the synced tip. */
  const headReads = (): ((args: string[]) => string) => {
    const shas = [bakedHead, mainTip];
    let n = 0;
    return (args) => {
      if (args.includes("--abbrev-ref")) return "origin/main";
      if (args.includes("HEAD")) return shas[Math.min(n++, shas.length - 1)]!;
      return "";
    };
  };

  it("fetches and hard-resets to origin/HEAD, in that order, and reports the base", async () => {
    const { runGit, calls } = fakeRunGit(() => false, headReads());
    const res = await ensureSandboxRepo({ runGit, remoteUrl: url, workspaceDir: ws });

    expect(res.ok).toBe(true);
    expect(res.cloned).toBe(false);
    expect(calls).toContainEqual(["-C", ws, "fetch", "origin", "--prune"]);
    expect(calls).toContainEqual(["-C", ws, "reset", "--hard", "origin/main"]);

    // Order is the guarantee: fetch, then reset. A reset before the fetch would move to a stale ref.
    const order = calls.map((c) => c.join(" "));
    expect(order.indexOf(`-C ${ws} fetch origin --prune`)).toBeLessThan(
      order.indexOf(`-C ${ws} reset --hard origin/main`),
    );

    // The base is reported so the run log can name what the branch was cut from.
    expect(res.base).toEqual({ before: bakedHead, after: mainTip });
  });

  it("is a reset, never a clean: untracked build output must survive", async () => {
    const { runGit, calls } = fakeRunGit(() => false, headReads());
    await ensureSandboxRepo({ runGit, remoteUrl: url, workspaceDir: ws });

    // Without this, every run would pay a reinstall of the image's node_modules.
    expect(calls.flat()).not.toContain("clean");
  });

  it("fails loudly when the fetch fails, rather than proceeding on a stale tree", async () => {
    const { runGit } = fakeRunGit((args) => args.includes("fetch"), headReads());
    const res = await ensureSandboxRepo({ runGit, remoteUrl: url, workspaceDir: ws });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/fetch/i);
  });

  it("fails loudly when the default branch cannot be resolved", async () => {
    const { runGit } = fakeRunGit((args) => args.includes("refs/remotes/origin/HEAD"), headReads());
    const res = await ensureSandboxRepo({ runGit, remoteUrl: url, workspaceDir: ws });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/default branch|origin\/HEAD/i);
  });

  it("leaves the fresh-clone path alone (a clone already lands on the default tip)", async () => {
    const { runGit, calls } = fakeRunGit((args) => args.includes("rev-parse") && args.includes("--is-inside-work-tree"));
    const res = await ensureSandboxRepo({ runGit, remoteUrl: url, workspaceDir: ws });

    expect(res).toEqual({ ok: true, cloned: true });
    expect(calls).toEqual([
      ["-C", ws, "rev-parse", "--is-inside-work-tree"],
      ["clone", url, ws],
    ]);
  });
});
