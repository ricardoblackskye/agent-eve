import { describe, it, expect, vi, afterEach } from "vitest";
import { checkGitHubTokenScope } from "../agent/lib/backlog-provider";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  delete process.env.GH_RELEASE_TOKEN;
  delete process.env.GH_STORY_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

async function runWithScopes(scopes: string[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: {
      get: (h: string) =>
        h.toLowerCase() === "x-oauth-scopes" ? scopes.join(", ") : null,
    },
  });
  vi.stubGlobal("fetch", fetchMock);
  return checkGitHubTokenScope();
}

describe("checkGitHubTokenScope", () => {
  it("accepts public_repo for a public repo (agent-eve)", async () => {
    process.env.GH_RELEASE_TOKEN = "tok";
    // This is the regression guard: the existing token only has write:discussion
    // + public_repo; the latter is enough to create issues on a public repo.
    const r = await runWithScopes(["public_repo", "write:discussion"]);
    expect(r.ok).toBe(true);
    expect(r.scopes).toContain("public_repo");
  });

  it("accepts repo (classic full) and issues: write (fine-grained)", async () => {
    process.env.GH_RELEASE_TOKEN = "tok";
    expect((await runWithScopes(["repo"])).ok).toBe(true);
    expect((await runWithScopes(["issues: write"])).ok).toBe(true);
  });

  it("rejects a token with only write:discussion (no issue access)", async () => {
    process.env.GH_RELEASE_TOKEN = "tok";
    const r = await runWithScopes(["write:discussion"]);
    expect(r.ok).toBe(false);
  });

  it("reports no-token when none is configured", async () => {
    const r = await checkGitHubTokenScope();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no token/i);
  });
});
