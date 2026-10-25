/**
 * Dependency advisory guard (#459).
 *
 * A resolved version lives in exactly one place - `package-lock.json` - and that is the only place a NESTED copy's
 * version appears. A scanner reports an advisory once, but the tree can carry several copies of the package, so the
 * check reads the lock rather than trusting `npm ls` at the top level or the alert count.
 *
 * A row is ADDED here as each advisory is cleared (#468 carries the rest). Rows are never removed, and this must not
 * grow into a global allowlist: a list of packages we tolerate an advisory against would hide the next one.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** One advisory: the package, the INCLUSIVE vulnerable bounds, and the first version that fixes it. */
export interface Advisory {
  package: string;
  from: string;
  to: string;
  /** Must NOT be flagged - it is the first fixed version, which is the boundary this guard exists to hold. */
  firstPatched: string;
}

export const GUARDED_ADVISORIES: readonly Advisory[] = [
  // #459 - three advisories against next 16.4.0 (2 critical, 1 high), cleared by moving to 16.4.3.
  { package: "next", from: "16.0.0", to: "16.4.0", firstPatched: "16.4.1" },
  // #468 - vite < 8.2.4 (high + 5 medium + 1 low).
  { package: "vite", from: "8.2.0", to: "8.2.3", firstPatched: "8.2.4" },
  // #468 - undici 7.x line < 7.30.1 (2 high + 4 medium); second vulnerable line below.
  { package: "undici", from: "7.18.0", to: "7.30.0", firstPatched: "7.30.1" },
  // #468 - undici 8.x line < 8.12.2 (same advisories, the other vulnerable range).
  { package: "undici", from: "8.0.0", to: "8.12.1", firstPatched: "8.12.2" },
  // #468 - dompurify <= 3.4.16 (1 critical + 1 high + 1 low).
  { package: "dompurify", from: "3.0.0", to: "3.4.16", firstPatched: "3.4.17" },
  // #468 - @vitest/mocker >= 4.1.11, < 4.1.12 (2 medium, build/test-only).
  {
    package: "@vitest/mocker",
    from: "4.1.11",
    to: "4.1.11",
    firstPatched: "4.1.12",
  },
  // #468 - zod < 4.6.6 (1 high, DIRECT dependency).
  { package: "zod", from: "4.0.0", to: "4.6.5", firstPatched: "4.6.6" },
  // #468 - postcss-selector-parser < 7.1.6 (1 medium, transitive via @tailwindcss/typography).
  {
    package: "postcss-selector-parser",
    from: "6.0.0",
    to: "7.1.5",
    firstPatched: "7.1.6",
  },
];

/**
 * Compare two dotted numeric versions. The ranges guarded here are numeric release lines, so pre-release and build
 * metadata are out of scope; an unparsable part counts as 0 rather than throwing inside a test helper.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10));
  const right = b.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = Number.isFinite(left[index]) ? (left[index] as number) : 0;
    const y = Number.isFinite(right[index]) ? (right[index] as number) : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

interface LockEntry {
  version?: string;
}

/**
 * Every resolved version of one package in the lock, TOP-LEVEL and NESTED.
 *
 * The nested matches matter more than the top-level one: a copy under
 * `node_modules/<parent>/node_modules/<pkg>` is invisible to a glance at `dependencies` in package.json, and it is
 * the copy that usually carries the advisory.
 */
export function resolvedVersions(
  packages: Record<string, LockEntry>,
  name: string,
): string[] {
  return Object.entries(packages)
    .filter(([path]) => path.endsWith(`node_modules/${name}`))
    .map(([, entry]) => entry.version)
    .filter((version): version is string => typeof version === "string");
}

/** The copies sitting inside the advisory's inclusive range, i.e. the versions that must not ship. */
export function offendingVersions(
  versions: readonly string[],
  advisory: Advisory,
): string[] {
  return versions.filter(
    (version) =>
      compareVersions(version, advisory.from) >= 0 &&
      compareVersions(version, advisory.to) <= 0,
  );
}

function readLockPackages(): Record<string, LockEntry> {
  const raw = readFileSync(join(process.cwd(), "package-lock.json"), "utf8");
  return (JSON.parse(raw) as { packages: Record<string, LockEntry> }).packages;
}

describe("#459 the advisory guard", () => {
  it("finds no copy of a guarded package inside its vulnerable range", () => {
    const packages = readLockPackages();

    for (const advisory of GUARDED_ADVISORIES) {
      const versions = resolvedVersions(packages, advisory.package);

      // Non-vacuity anchor: without this, an empty scan would pass while protecting nothing.
      expect(
        versions.length,
        `${advisory.package} should have at least one copy in the lock`,
      ).toBeGreaterThan(0);

      expect(
        offendingVersions(versions, advisory),
        `${advisory.package} resolves inside ${advisory.from}..${advisory.to}`,
      ).toEqual([]);
    }
  });

  it("does not flag the first PATCHED version, and does flag the one below it", () => {
    const advisory = GUARDED_ADVISORIES[0] as Advisory;

    expect(offendingVersions([advisory.firstPatched], advisory)).toEqual([]);
    expect(offendingVersions([advisory.to], advisory)).toEqual([advisory.to]);
    expect(offendingVersions([advisory.from], advisory)).toEqual([
      advisory.from,
    ]);
    expect(offendingVersions(["15.99.99"], advisory)).toEqual([]);
    expect(offendingVersions(["17.0.0"], advisory)).toEqual([]);
  });

  it("sees a NESTED copy, which is where the advisory usually lives", () => {
    const nested = {
      "node_modules/next": { version: "16.4.3" },
      "node_modules/some-parent/node_modules/next": { version: "16.4.0" },
    };
    const advisory = GUARDED_ADVISORIES[0] as Advisory;

    expect(resolvedVersions(nested, "next")).toEqual(["16.4.3", "16.4.0"]);
    expect(
      offendingVersions(resolvedVersions(nested, "next"), advisory),
    ).toEqual(["16.4.0"]);
  });

  it("orders versions numerically, not as strings", () => {
    // "16.4.10" is ABOVE 16.4.3; a string comparison puts it below and would silently pass a vulnerable copy.
    expect(compareVersions("16.4.10", "16.4.3")).toBe(1);
    expect(compareVersions("16.10.0", "16.9.0")).toBe(1);
    expect(compareVersions("16.4.0", "16.4.0")).toBe(0);
    expect(compareVersions("16.3.9", "16.4.0")).toBe(-1);
  });
});
