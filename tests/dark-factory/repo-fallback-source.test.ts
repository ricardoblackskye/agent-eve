import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeOwnerRepo } from "../../agent/lib/backlog-provider";

/**
 * The last hardcoded owner/repo fallbacks (#348 R2 Tasks 3-4).
 *
 * Both of these are being replaced in the same change because they are the same mistake: a literal owner
 * and repo sitting behind an `||`, so the code compiles a value that nobody chose. The release-manager
 * tools have no test of their own, so their wiring is pinned by reading the source; the backlog provider's
 * default IS asserted elsewhere and is deliberately PRESERVED - only its source changes, from a literal in
 * the module to `default_repo` in dark-factory.config.json.
 */
const tools = ["read_current_notes", "write_release_notes"].map((name) => ({
  name,
  source: readFileSync(
    `agent/subagents/release-manager/tools/${name}.ts`,
    "utf8",
  ),
}));

describe("no release-manager tool hardcodes a repository", () => {
  it("has no literal owner or repo", () => {
    for (const { name, source } of tools) {
      expect(source, name).not.toContain('"ricardoblackskye"');
      expect(source, name).not.toContain('"agent-eve"');
    }
  });

  it("resolves through the shared module instead of composing the fallback inline", () => {
    for (const { name, source } of tools) {
      expect(source, name).toContain("resolveOwnerRepo(");
    }
  });
});

describe("the backlog provider's default is config-sourced, not a literal", () => {
  it("has no built-in owner or repo literal", () => {
    const source = readFileSync("agent/lib/backlog-provider.ts", "utf8");
    expect(source).not.toMatch(/fallbackOwner\s*=\s*"/);
    expect(source).not.toMatch(/fallbackRepo\s*=\s*"/);
  });

  it("still applies a default, now read from the config file", () => {
    // A characterization guard: this passes before AND after, because the behaviour is deliberately
    // preserved. It is what proves the default did not vanish while its source was being changed - which
    // is the risk in this kind of refactor, and the reason the existing assertion stays untouched.
    const { owner, repo } = sanitizeOwnerRepo(undefined, undefined);
    expect(owner).toBe("ricardoblackskye");
    expect(repo).toBe("agent-eve");
  });
});

describe("the webhook prompt does not name a board (#348 R2 Task 6)", () => {
  const source = readFileSync("app/api/github/webhook/route.ts", "utf8");

  it("stops instructing the agent to use a specific login and project number", () => {
    // This is the worst place for a hardcode to live: prose that TELLS an agent what to do. A fallback
    // can only be wrong when it is used; an instruction is followed.
    expect(source).not.toContain('login "ricardoblackskye"');
    expect(source).not.toMatch(/projectNumber 3/);
  });

  it("tells the agent the tool resolves the board instead", () => {
    expect(source).toContain("dark-factory.config.json");
    expect(source).toMatch(/Do NOT supply projectOwner/);
  });
});
