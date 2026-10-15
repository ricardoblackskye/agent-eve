import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every file under `agent/lib` must be a supported authored module (#365).
 *
 * Eve's build discovery enforces this, and NOTHING ELSE IN THIS REPOSITORY'S CHECKS DOES. A vendored
 * markdown file placed under `agent/lib` passed the whole local gate - the test suite, `tsc`, cspell,
 * markdownlint AND `npm run build` - and then failed the Vercel build, because `npm run build` runs the
 * Next build only and never Eve's discovery:
 *
 *   Discovery failed with 1 error(s)
 *   - Error: Expected ".../agent/lib/dark-factory/planning-guidance/writing-plans.md" to be a supported
 *     authored module within "lib/".
 *
 * This guard turns that from a failed deployment into a failed test. Data the agent READS belongs
 * outside `agent/lib`, not in it.
 */
function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      found.push(...filesUnder(full));
    } else {
      found.push(full.replace(/\\/g, "/"));
    }
  }
  return found;
}

describe("Eve module discovery", () => {
  it("keeps every file under agent/lib a supported authored module", () => {
    const offenders = filesUnder("agent/lib").filter(
      (file) => !file.endsWith(".ts") && !file.endsWith(".tsx"),
    );
    expect(offenders).toEqual([]);
  });

  it("finds the agent modules at all, so the guard cannot pass by looking nowhere", () => {
    // A guard that silently scanned an empty tree would pass forever.
    expect(filesUnder("agent/lib").length).toBeGreaterThan(50);
  });
});
