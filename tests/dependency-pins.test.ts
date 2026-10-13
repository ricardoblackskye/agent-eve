import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * #303 — no installed copy of `undici` may sit inside a known vulnerable range.
 *
 * Dependabot filed TEN alerts for ONE nested copy: `eve` pins `undici` to exactly 8.9.0. A nested copy
 * is invisible to a top-level `npm ls`, so the same failure returns silently. The lockfile is the only
 * place the RESOLVED versions live, so that is what this guard reads.
 */
const lock = JSON.parse(
  readFileSync(resolve(process.cwd(), "package-lock.json"), "utf-8"),
) as { packages?: Record<string, { version?: string } | undefined> };
const pkg = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf-8"),
) as { overrides?: Record<string, unknown> };

/** Every #303 advisory shares one range: vulnerable `>= 8.0.0, < 8.10.2`; first patched 8.10.2. */
const VULNERABLE_FLOOR = [8, 0, 0];
const PATCHED_FLOOR = [8, 10, 2];

function semver(value: string): number[] {
  return value
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10));
}

function isBelow(left: number[], right: number[]): boolean {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/** Inside `>= floor, < ceiling` — the shape Dependabot reports as a vulnerable range. */
function isInsideRange(
  version: string,
  floor: number[],
  ceiling: number[],
): boolean {
  const parts = semver(version);
  return !isBelow(parts, floor) && isBelow(parts, ceiling);
}

/** Every resolved `undici`, wherever it is nested. */
function undiciCopies(): { path: string; version: string }[] {
  return Object.entries(lock.packages ?? {})
    .filter(
      ([path]) =>
        path === "node_modules/undici" || path.endsWith("/node_modules/undici"),
    )
    .map(([path, entry]) => ({ path, version: String(entry?.version ?? "") }));
}

describe("#303 undici dependency guard", () => {
  it("finds the installed undici copies (guards against a vacuous pass)", () => {
    const copies = undiciCopies();
    expect(copies.length).toBeGreaterThanOrEqual(1);
    for (const copy of copies) {
      expect(copy.version, copy.path).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it("compares the vulnerable range correctly, boundaries included", () => {
    expect(isInsideRange("8.0.0", VULNERABLE_FLOOR, PATCHED_FLOOR)).toBe(true);
    expect(isInsideRange("8.9.0", VULNERABLE_FLOOR, PATCHED_FLOOR)).toBe(true);
    expect(isInsideRange("8.10.1", VULNERABLE_FLOOR, PATCHED_FLOOR)).toBe(true);
    // The floor is the first PATCHED version, so it must NOT be flagged.
    expect(isInsideRange("8.10.2", VULNERABLE_FLOOR, PATCHED_FLOOR)).toBe(
      false,
    );
    expect(isInsideRange("8.11.2", VULNERABLE_FLOOR, PATCHED_FLOOR)).toBe(
      false,
    );
    expect(isInsideRange("7.30.0", VULNERABLE_FLOOR, PATCHED_FLOOR)).toBe(
      false,
    );
    expect(isInsideRange("9.0.0", VULNERABLE_FLOOR, PATCHED_FLOOR)).toBe(false);
  });

  it("installs no undici copy inside the vulnerable range", () => {
    const vulnerable = undiciCopies().filter((copy) =>
      isInsideRange(copy.version, VULNERABLE_FLOOR, PATCHED_FLOOR),
    );
    expect(vulnerable).toEqual([]);
  });

  it("keeps eve's copy at or above the patched floor", () => {
    const eve = undiciCopies().filter((copy) =>
      copy.path.startsWith("node_modules/eve/"),
    );
    expect(eve.length).toBeGreaterThanOrEqual(1);
    for (const copy of eve) {
      expect(
        isBelow(semver(copy.version), PATCHED_FLOOR),
        `${copy.path} resolves ${copy.version}`,
      ).toBe(false);
    }
  });

  it("keeps the eve-scoped override that holds it there", () => {
    // Scoped to eve on purpose: an unscoped override would drag the AI SDK's undici 7.x to 8.x.
    const override = pkg.overrides?.eve as Record<string, string> | undefined;
    expect(override?.undici).toBeDefined();
    expect(isBelow(semver(String(override?.undici)), PATCHED_FLOOR)).toBe(
      false,
    );
  });

  it("stops the eve override leaking onto the AI SDK, which declares undici 7.x", () => {
    // Observed: `{"eve":{"undici":"8.11.2"}}` ALONE also moved @ai-sdk/provider-utils' undici from
    // 7.30.0 to 8.11.2, violating the `^7.28.0` / `^7.29.0` it declares. npm's dedupe, not ours.
    // The explicit pin below holds the AI SDK where it was, so the eve fix stays confined to eve.
    const guard = pkg.overrides?.["@ai-sdk/provider-utils"] as
      | Record<string, string>
      | undefined;
    expect(guard?.undici).toBeDefined();

    const leaked = undiciCopies().filter(
      (copy) =>
        (copy.path.startsWith("node_modules/ai/") ||
          copy.path.startsWith("node_modules/@ai-sdk/")) &&
        !isBelow(semver(copy.version), [8, 0, 0]),
    );
    expect(leaked).toEqual([]);
  });
});
