import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const examplePath = resolve(process.cwd(), ".env.example");

// Strip comments and blank lines, then map NAME -> value.
function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

describe(".env.example", () => {
  it("exists at the repo root", () => {
    expect(existsSync(examplePath)).toBe(true);
  });

  const raw = existsSync(examplePath) ? readFileSync(examplePath, "utf-8") : "";
  const vars = parseDotEnv(raw);

  it("documents GH_RELEASE_TOKEN", () => {
    expect(Object.keys(vars)).toContain("GH_RELEASE_TOKEN");
  });

  it("documents GH_WEBHOOK_SECRET", () => {
    expect(Object.keys(vars)).toContain("GH_WEBHOOK_SECRET");
  });

  it("documents OPENROUTER_API_KEY", () => {
    expect(Object.keys(vars)).toContain("OPENROUTER_API_KEY");
  });

  it("documents EVE_API_KEY", () => {
    expect(Object.keys(vars)).toContain("EVE_API_KEY");
  });

  it("documents the optional story trigger overrides", () => {
    expect(Object.keys(vars)).toContain("EVE_STORY_MENTION");
    expect(Object.keys(vars)).toContain("EVE_STORY_LABEL");
  });

  it("contains no real-looking secret values", () => {
    // Placeholders only — gitleaks runs in MegaLinter and would flag a real token.
    for (const [name, value] of Object.entries(vars)) {
      if (!value) continue;
      expect(`${name}=${value}`).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      expect(`${name}=${value}`).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
    }
  });

  it("marks GH_RELEASE_TOKEN as needing issues write scope", () => {
    // R1 creates issues + comments; contents-only tokens 403.
    // The scope is documented in the comment block ABOVE the variable, so
    // match that block rather than scanning forward from the name.
    const block = raw.slice(
      0,
      raw.indexOf("GH_RELEASE_TOKEN=") === -1
        ? raw.length
        : raw.indexOf("GH_RELEASE_TOKEN="),
    );
    expect(block).toMatch(/Issues:\s*Read and write/i);
    expect(block).toMatch(/Personal access token/i);
  });

  it("documents a command to verify the token's scopes before deploying", () => {
    // Reviewer finding: the required scope was asserted but never verified.
    // The file must show HOW to check, not just what is needed.
    expect(raw).toMatch(/x-oauth-scopes/);
    expect(raw).toMatch(/rate_limit/);
  });

  it("warns that a fine-grained PAT needs both scopes selected separately", () => {
    expect(raw).toMatch(/[Ff]ine-grained PAT/);
    expect(raw).toMatch(/Contents/);
  });

  it("states that GH_WEBHOOK_SECRET is required in deployed environments", () => {
    // Reviewer finding: an unset secret silently bypassed signature
    // verification, so the example must not imply it is optional.
    const block = raw.slice(
      0,
      raw.indexOf("GH_WEBHOOK_SECRET=") === -1
        ? raw.length
        : raw.indexOf("GH_WEBHOOK_SECRET="),
    );
    expect(block).toMatch(/REQUIRED in deployed environments/i);
    expect(block).toMatch(/HTTP 500|refuses to process/i);
  });
});

describe(".gitignore", () => {
  const ignore = readFileSync(resolve(process.cwd(), ".gitignore"), "utf-8");

  it("still ignores .env files", () => {
    expect(ignore).toMatch(/^\.env\*$/m);
  });

  it("negates .env.example so it can be committed", () => {
    // CRLF-safe: the repo uses CRLF line endings, so anchor on the line start
    // and allow an optional carriage return before the end of line.
    expect(ignore).toMatch(/^!\.env\.example\r?$/m);
  });
});

describe("README provisioning docs", () => {
  const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf-8");

  it("points readers at .env.example", () => {
    expect(readme).toContain(".env.example");
  });

  it("states that GH_RELEASE_TOKEN needs issues write scope", () => {
    expect(readme).toMatch(
      /GH_RELEASE_TOKEN[\s\S]{0,400}?issues:\s*read and write/i,
    );
  });
});
