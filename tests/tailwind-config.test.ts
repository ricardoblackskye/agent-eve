/**
 * Tailwind adoption guard (#233).
 *
 * Tailwind is build configuration, so there is no runtime behaviour to drive;
 * this asserts the wiring structurally. The last test is the important one: it
 * guards the *actual* regression this leg risks.
 *
 * Tailwind's Preflight sets `h1`-`h6 { font-size: inherit; font-weight: inherit }`.
 * This app has no heading rules of its own (only `body`), so it currently relies
 * on browser defaults for heading size. Without explicit heading rules, adopting
 * Tailwind would silently flatten every heading in the application to body text
 * across all seven pages. That is the change this guard exists to prevent.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const DEPS: Record<string, string> = {
  ...(PKG.dependencies ?? {}),
  ...(PKG.devDependencies ?? {}),
};

const POSTCSS_CANDIDATES = [
  "postcss.config.mjs",
  "postcss.config.js",
  "postcss.config.cjs",
];

function postcssConfig(): string {
  const found = POSTCSS_CANDIDATES.filter((name) => existsSync(join(ROOT, name)));
  if (found.length === 0) return "";
  return found.map((name) => readFileSync(join(ROOT, name), "utf8")).join("\n");
}

/** Rules declared for a bare element selector, e.g. `h2 { ... }`. */
function rulesFor(selector: string): string {
  const pattern = new RegExp(
    `(^|[,}])\\s*${selector}\\s*(,[^{]*)?\\{([^}]*)\\}`,
    "gm",
  );
  const bodies: string[] = [];
  for (const match of CSS.matchAll(pattern)) bodies.push(match[3]);
  return bodies.join("\n");
}

describe("Tailwind adoption (#233)", () => {
  it("declares the Tailwind packages", () => {
    expect(DEPS).toHaveProperty("tailwindcss");
    expect(DEPS).toHaveProperty("@tailwindcss/typography");
  });

  it("imports Tailwind from the global stylesheet", () => {
    expect(CSS).toMatch(/@import\s+["']tailwindcss["']/);
  });

  it("wires PostCSS to the Tailwind plugin", () => {
    const config = postcssConfig();
    expect(config, "no postcss config found").not.toBe("");
    expect(config).toContain("@tailwindcss/postcss");
  });

  it("keeps Preflight from flattening headings", () => {
    // The regression guard: every heading level must carry its own font-size,
    // because Preflight resets them to `inherit` and the app defines none.
    for (const level of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
      const body = rulesFor(level);
      expect(body, `${level} has no explicit rule`).not.toBe("");
      expect(body, `${level} must set font-size`).toMatch(/font-size\s*:/);
    }
    // Larger headings must actually be larger than body text.
    expect(rulesFor("h1")).toMatch(/font-size\s*:\s*2/);
    expect(rulesFor("h2")).toMatch(/font-size\s*:\s*1\.5/);
  });
});