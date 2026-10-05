import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Style contract for the Dark Factory surface (#258).
 *
 * A `df-*-table` class used by a component but never declared in
 * `app/globals.css` renders completely unstyled — which is exactly how the
 * usage and budget tables shipped, and how the cost and policy tables shipped
 * before #205. This guard turns that recurring defect into a test failure.
 */

const ROOT = join(__dirname, "..", "..");
const UI_DIR = join(ROOT, "app", "dark-factory");
const CSS = readFileSync(join(ROOT, "app", "globals.css"), "utf8");

function componentFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...componentFiles(path));
    else if (entry.name.endsWith(".tsx")) found.push(path);
  }
  return found;
}

/** Every `df-*-table` class name used in a dark-factory component. */
function tableClassesUsed(): Set<string> {
  const used = new Set<string>();
  for (const file of componentFiles(UI_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/className="([^"]*)"/g)) {
      for (const token of (match[1] ?? "").split(/\s+/)) {
        if (/^df-[a-z-]*table[a-z-]*$/.test(token)) used.add(token);
      }
    }
  }
  return used;
}

describe("dark factory style contract (#258)", () => {
  it("discovers the table classes (so this guard cannot pass vacuously)", () => {
    const used = tableClassesUsed();
    expect(used.size).toBeGreaterThan(0);
    expect(used).toContain("df-table");
  });

  it("declares a globals.css rule for every table class a component uses", () => {
    const used = [...tableClassesUsed()].sort();
    const undeclared = used.filter((name) => !CSS.includes(`.${name}`));
    expect(
      undeclared,
      `these classes are used but have no rule in app/globals.css: ${undeclared.join(", ")}`,
    ).toEqual([]);
  });
});