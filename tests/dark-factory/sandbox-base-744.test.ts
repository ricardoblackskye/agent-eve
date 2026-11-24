import { describe, expect, it } from "vitest";

import { ensureSandboxRepo } from "../../agent/lib/dark-factory/git-push";
import type { SandboxRepoDeps } from "../../agent/lib/dark-factory/git-push";

/**
 * #744 task 2. The documented image already carries the checkout, and prepare takes it to the
 * repository s CURRENT DEFAULT tip. On a re-run that is the defect: the default is not the branch
 * the first run pushed, so the new commit cannot descend from it and git refuses the push.
 *
 * The git calls are recorded, so the base is pinned without a sandbox.
 */
const DF_BRANCH = "feat/dark-factory-256";

function fakeGit(options: { inside?: boolean } = {}) {
  const calls: string[][] = [];
  const runGit = async (args: string[]) => {
    calls.push(args);
    const line = args.join(" ");
    if (line.includes("is-inside-work-tree"))
      return { exitCode: (options.inside ?? true) ? 0 : 1, output: "true" };
    if (line.includes("symbolic-ref") || line.includes("origin/HEAD"))
      return { exitCode: 0, output: "refs/remotes/origin/main" };
    // A fetched remote ref must differ from the current HEAD, or the code rightly decides the
    // checkout is already at the tip and returns before moving it - which is what made the
    // control fail and hid whether the base was honoured.
    if (line.includes("origin/")) return { exitCode: 0, output: "e4f5a6b" };
    if (line.includes("rev-parse")) return { exitCode: 0, output: "a1b2c3d" };
    return { exitCode: 0, output: "" };
  };
  return { runGit, calls };
}

function moves(calls: string[][]): string[][] {
  return calls.filter((args) => args.join(" ").includes("reset"));
}

describe("the sandbox checkout base is applied (#744 task 2)", () => {
  it("checks out the DF branch when that is the chosen base, not the default tip", async () => {
    const { runGit, calls } = fakeGit();
    const result = await ensureSandboxRepo({
      workspaceDir: "/workspace",
      remoteUrl: "https://example.test/owner/repo.git",
      base: DF_BRANCH,
      runGit,
    } as unknown as SandboxRepoDeps);
    expect(result.ok).toBe(true);
    const made = moves(calls).map((args) => args.join(" "));
    expect(made.some((line) => line.includes(DF_BRANCH))).toBe(true);
    expect(made.some((line) => line.includes("origin/" + DF_BRANCH))).toBe(true);
  });

  // The control: with the default as the base the old behaviour must still hold.
  it("takes the default tip when the base is the default branch", async () => {
    const { runGit, calls } = fakeGit();
    const result = await ensureSandboxRepo({
      workspaceDir: "/workspace",
      remoteUrl: "https://example.test/owner/repo.git",
      base: "main",
      runGit,
    } as unknown as SandboxRepoDeps);
    expect(result.ok).toBe(true);
    const made = moves(calls).map((args) => args.join(" "));
    expect(made.some((line) => line.includes("main"))).toBe(true);
  });

  it("applies the base on the clone path too, where the image carries no repo", async () => {
    const { runGit, calls } = fakeGit({ inside: false });
    const result = await ensureSandboxRepo({
      workspaceDir: "/workspace",
      remoteUrl: "https://example.test/owner/repo.git",
      base: DF_BRANCH,
      runGit,
    } as unknown as SandboxRepoDeps);
    expect(result.ok).toBe(true);
    expect(calls.some((args) => args.join(" ").includes("clone"))).toBe(true);
    const made = moves(calls).map((args) => args.join(" "));
    expect(made.some((line) => line.includes(DF_BRANCH))).toBe(true);
  });
});
