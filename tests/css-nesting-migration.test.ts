/**
 * CSS nesting migration (#241) — drift guard.
 *
 * The #241 refactor converts the shared `.df-*` component classes in
 * `app/globals.css` from flat selectors to native CSS `&` nesting. It must be
 * mechanical and behavior-preserving: the *resolved* stylesheet (selectors +
 * their declaration blocks) is unchanged.
 *
 * This test locks that contract. `resolveRules` expands `&` nesting to flat
 * selectors; the bag of `selector => declarations` must equal the committed
 * baseline generated from the pre-refactor file. The mutation tests prove the
 * guard fires (non-vacuous) — it is not a vacuous pass.
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
    const stripped = CSS.replace(/\.df-panel-body\s*\{[^}]*\}/, ".df-panel-body {}");
    const b = bag(stripped);
    expect(b).not.toEqual(BASELINE);
    const original = BASELINE.find((x) => x.startsWith(".df-panel-body "));
    expect(original).toBeDefined();
    expect(b).not.toContain(original);
  });

  it("mutation: renaming a .df-* class is detected", () => {
    const renamed = CSS.replace(/\.df-panel-body\b/g, ".df-panel-bodyx");
    expect(bag(renamed)).not.toEqual(BASELINE);
  });
});
