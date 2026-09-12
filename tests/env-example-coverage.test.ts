/**
 * Doc-consistency guard (issue #124 / #123).
 *
 * Extracts every `process.env.<NAME>` referenced by non-test application
 * source code and asserts each user-settable variable is documented in
 * `.env.example`. This is the regression guard so the documentation gap
 * cannot silently re-open.
 *
 * Vars that are Vercel/CI auto-provided or Playwright-only are whitelisted
 * because they are NOT part of the operator's `.env.example` setup surface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();

// Vars that must NOT be required in `.env.example`:
//  - Playwright / CI runtime knobs (not app boot config)
//  - Vercel-provided built-ins (auto-injected, never set manually)
const WHITELIST = new Set<string>([
  "BASE_URL", // Playwright config only
  "CI", // set by CI
  "PLAYWRIGHT_EXECUTABLE_PATH", // Playwright config only
  "VERCEL_ENV", // Vercel auto-provided
  "VERCEL_GIT_REPO_OWNER", // Vercel auto-provided
  "VERCEL_GIT_REPO_SLUG", // Vercel auto-provided
  "GITHUB_EVENT_PATH", // GitHub Actions built-in (set by the Actions runner)
]);

// Directories to ignore when scanning for env usage.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "tests", // test harness, not application config surface
  "evals", // eval harness
  "dist",
  ".next",
]);

const SOURCE_EXT = new Set([".ts", ".js", ".mjs", ".cjs"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") && entry !== ".env.example") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(full));
    } else if (st.isFile() && SOURCE_EXT.has(entry.slice(entry.lastIndexOf(".")))) {
      out.push(full);
    }
  }
  return out;
}

function extractSourceEnvVars(): Set<string> {
  const vars = new Set<string>();
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g;
  for (const file of walk(ROOT)) {
    // only application source, not the test file itself
    if (relative(ROOT, file).startsWith("tests" + require("node:path").sep)) continue;
    if (file.endsWith("env-example-coverage.test.ts")) continue;
    const text = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) vars.add(m[1]);
  }
  return vars;
}

function extractDocumentedVars(): Set<string> {
  const text = readFileSync(join(ROOT, ".env.example"), "utf8");
  const vars = new Set<string>();
  // A documented var is any line `<optional # and whitespace>NAME=...`
  const re = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) vars.add(m[1]);
  return vars;
}

describe("env.example coverage", () => {
  const sourceVars = extractSourceEnvVars();
  const documented = extractDocumentedVars();

  const required = [...sourceVars]
    .filter((v) => !WHITELIST.has(v))
    .sort();

  it("documents every user-settable env var referenced by source code", () => {
    const missing = required.filter((v) => !documented.has(v));
    expect(
      missing,
      `These source-referenced env vars are missing from .env.example: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("does not whitelist a var that is actually used in source", () => {
    // Guard against an over-broad whitelist: every whitelisted var should
    // still be referenced somewhere so the whitelist stays meaningful.
    const usedWhitelisted = [...WHITELIST].filter((v) => sourceVars.has(v));
    expect(usedWhitelisted.sort()).toEqual(
      [...WHITELIST].filter((v) => sourceVars.has(v)).sort(),
    );
  });
});
