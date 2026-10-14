import { describe, expect, it, vi } from "vitest";
import { createInMemoryCredentialVault } from "../../agent/lib/dark-factory/credential-vault";
import {
  buildGitPushCommand,
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
