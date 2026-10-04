/**
 * CSS drift guard for the shared `.df-*` component classes in `app/globals.css`.
 *
 * These classes are written FLAT. They were briefly written with `&-suffix`
 * nesting, but that is SCSS syntax, not valid CSS nesting: Lightning CSS
 * (Tailwind v4) parses `&-body` as a type selector `-body` and emits the invalid
 * `-body.df-panel`, so the rule never matches — which is why the dashboard tiles
 * had no padding (#205). The resolved `selector => declarations` bag must equal
 * the committed baseline; the mutation tests prove the guard is non-vacuous.
 */
// @ts-ignore - plain JS module, no type declarations needed
import { resolveRules } from "./support/cssResolve.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, "app", "globals.css"), "utf8");
const BASELINE = JSON.parse(
  readFileSync(join(ROOT, "tests", "fixtures", "df-css-baseline.json"), "utf8"),
) as string[];

function bag(css: string): string[] {
  return resolveRules(css)
    .map(([s, d]) => `${s} => ${d}`)
    .sort();
}

describe("CSS nesting migration (#241)", () => {
  it("resolves to the same selector+declaration bag as the baseline (no behavior change)", () => {
    expect(bag(CSS)).toEqual(BASELINE);
  });

  it("mutation: dropping a .df-* rule's declarations is detected", () => {
    const stripped = CSS.replace(
      /\.df-panel-body\s*\{[^}]*\}/,
      ".df-panel-body {}",
    );
    const b = bag(stripped);
    expect(b).not.toEqual(BASELINE);
    const original = BASELINE.find((x) => x.startsWith(".df-panel-body "));
    expect(original).toBeDefined();
    expect(b).not.toContain(original);
  });

  it("mutation: a renamed .df-* class is detected", () => {
    const renamed = CSS.replace(/\.df-panel-body\b/g, ".df-panel-body-renamed");
    expect(bag(renamed)).not.toEqual(BASELINE);
  });
});
